import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import tls from "node:tls";
import { llmRuntime, resolveModel } from "@/lib/agent/runtime/config";
import type { Context } from "../../vendor/openclaw/packages/llm-core/src/types";

const { agents } = vi.hoisted(() => ({ agents: [] as Array<{ destroy(): Promise<void> }> }));
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, ProxyAgent: class extends actual.ProxyAgent {
    constructor(...args: ConstructorParameters<typeof actual.ProxyAgent>) {
      super(...args);
      agents.push(this);
    }
  } };
});

describe("Gemini 显式客户端代理", () => {
  const trust = tls as typeof tls & {
    getCACertificates(type: "default"): string[];
    setDefaultCACertificates(certs: string[]): void;
  };
  const defaultCAs = trust.getCACertificates("default");
  const sockets = new Set<Duplex>();
  const bodies: Record<string, unknown>[] = [];
  const connects: string[] = [];
  let rejectProxy = false;
  let holdResponse = false;
  let certDir: string;
  let origin: ReturnType<typeof createHttpsServer>;
  let proxy: ReturnType<typeof createHttpServer>;
  let originUrl: string;
  let proxyUrl: string;
  const context: Context = {
    messages: [{ role: "user", timestamp: 1, content: [
      { type: "text", text: "测试" },
      { type: "image", mimeType: "image/png", data: "AQID", attachmentId: "fixture", source: { kind: "attachment", sha256: "a".repeat(64) } },
    ] }],
    tools: [{ name: "echo", description: "测试工具", parameters: { type: "object", properties: { value: { type: "string" } } } }],
  };

  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), "gemini-proxy-test-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certDir, "key"), "-out", join(certDir, "cert"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
    // 测试证书加入信任链；不关闭 TLS 验证。
    trust.setDefaultCACertificates([...defaultCAs, readFileSync(join(certDir, "cert"), "utf8")]);
    origin = createHttpsServer({ key: readFileSync(join(certDir, "key")), cert: readFileSync(join(certDir, "cert")) }, async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      bodies.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "代理回复" }] } }] })}\n\n`);
      if (!holdResponse) res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "echo", args: { value: "ok" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } })}\n\n`);
    });
    proxy = createHttpServer((_req, res) => { res.writeHead(405); res.end(); });
    proxy.on("connect", (req, client, head) => {
      connects.push(req.url!);
      sockets.add(client);
      if (rejectProxy) { client.end("HTTP/1.1 503 Service Unavailable\r\n\r\n"); return; }
      const upstream = connect((origin.address() as AddressInfo).port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      sockets.add(upstream);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    await new Promise<void>((done) => origin.listen(0, "127.0.0.1", done));
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    originUrl = `https://localhost:${(origin.address() as AddressInfo).port}/v1beta`;
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rejectProxy = false;
    holdResponse = false;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  });
  afterAll(async () => {
    await Promise.all(agents.map((agent) => agent.destroy()));
    for (const socket of sockets) socket.destroy();
    trust.setDefaultCACertificates(defaultCAs);
    await Promise.all([new Promise<void>((done) => proxy.close(() => done())), new Promise<void>((done) => origin.close(() => done()))]);
    rmSync(certDir, { recursive: true });
  });

  it("真实 SDK 经 HTTPS CONNECT 流式回复，保留工具、图片和用量，其他模型继续直连", async () => {
    vi.stubEnv("GEMINI_PROXY_URL", proxyUrl);
    const direct = vi.fn(async () => new Response('data: {"choices":[{"index":0,"delta":{"content":"直连回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", direct);
    const result = await llmRuntime().completeSimple({ ...resolveModel("inspiration"), baseUrl: originUrl }, context, { apiKey: "fixture-key", reasoning: "medium" });
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "代理回复" }));
    expect(result.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "echo" }));
    expect(result.usage.input).toBe(2);
    expect(connects).toContain(`localhost:${(origin.address() as AddressInfo).port}`);
    expect(bodies.at(-1)).toMatchObject({ contents: [{ parts: expect.arrayContaining([{ inlineData: { mimeType: "image/png", data: "AQID" } }]) }] });
    expect(bodies.at(-1)).toHaveProperty("tools");
    expect(direct).not.toHaveBeenCalled();
    const qwen = await llmRuntime().completeSimple(resolveModel("resonance"), { messages: [{ role: "user", content: "测试", timestamp: 1 }] }, { apiKey: "fixture-key" });
    expect(qwen.stopReason).toBe("stop");
    expect(direct).toHaveBeenCalledOnce();
  });

  it("流式回复中的停止信号通过专用代理到达 SDK", async () => {
    vi.stubEnv("GEMINI_PROXY_URL", proxyUrl);
    holdResponse = true;
    const abort = new AbortController();
    const stream = await llmRuntime().streamSimple({ ...resolveModel("inspiration"), baseUrl: originUrl }, context, { apiKey: "fixture-key", signal: abort.signal });
    for await (const event of stream) {
      if (event.type === "text_delta") abort.abort();
    }
    expect((await stream.result()).stopReason).toBe("aborted");
  });

  it("代理拒绝连接明确失败，不回退默认 fetch", async () => {
    vi.stubEnv("GEMINI_PROXY_URL", proxyUrl);
    rejectProxy = true;
    const direct = vi.fn(() => { throw new Error("不应直连"); });
    vi.stubGlobal("fetch", direct);
    const result = await llmRuntime().completeSimple({ ...resolveModel("inspiration"), baseUrl: originUrl }, context, { apiKey: "fixture-key" });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBeTruthy();
    expect(direct).not.toHaveBeenCalled();
  });

  it("模型代理接线和 SDK Node ESM/CJS 安装补丁均存在", () => {
    const config = readFileSync("lib/agent/runtime/config.ts", "utf8");
    expect(config).toContain('proxyEnv: "GEMINI_PROXY_URL"');
    expect(config).toContain("configureAiTransportHost({");
    expect(config).toContain("modelProxyFetch(proxyUrl)");
    const require = createRequire(import.meta.url);
    const sdk = createRequire(require.resolve("@openclaw/ai")).resolve("@google/genai");
    for (const file of [sdk, sdk.replace(/\.cjs$/, ".mjs")]) {
      expect(readFileSync(file, "utf8")).toContain("this.clientOptions.httpOptions?.fetch ?? fetch");
    }
  });
});
