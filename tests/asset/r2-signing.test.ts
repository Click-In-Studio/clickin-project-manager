import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("R2 Authorization header 签名", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("R2_ACCOUNT_ID", "test-account");
    vi.stubEnv("R2_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret-key");
    vi.stubEnv("R2_BUCKET", "test-bucket");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("HEAD 发送并签入空 payload hash", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 200,
      headers: { "Content-Length": "123", "Content-Type": "audio/mp4" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { headR2Object } = await import("@/lib/r2");
    await expect(headR2Object("agent-attachments/aat_test/voice.mp4")).resolves.toEqual({
      size: 123,
      contentType: "audio/mp4",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(init.method).toBe("HEAD");
    expect(headers.get("x-amz-content-sha256")).toBe(EMPTY_SHA256);
    expect(headers.get("authorization")).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
  });

  it("DELETE 发送并签入空 payload hash，且拒绝非成功响应", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const { deleteR2Object } = await import("@/lib/r2");
    await expect(deleteR2Object("assets/af_test/file.pdf")).rejects.toThrow("R2 DELETE failed: 400");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(init.method).toBe("DELETE");
    expect(headers.get("x-amz-content-sha256")).toBe(EMPTY_SHA256);
    expect(headers.get("authorization")).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
  });

  it("DELETE 只在 R2 成功后完成", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const { deleteR2Object } = await import("@/lib/r2");
    await expect(deleteR2Object("assets/af_test/file.pdf")).resolves.toBeUndefined();
  });

  it("服务端 PUT 可把 ReadableStream 原样交给 fetch，不先缓冲整个对象", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { putR2ObjectStream } = await import("@/lib/r2");
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("stream-body")); controller.close(); },
    });

    await expect(putR2ObjectStream("agent-attachments/aat_test/file.pdf", body, "application/pdf"))
      .resolves.toBeUndefined();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { duplex?: string }];
    expect(init).toMatchObject({ method: "PUT", duplex: "half", body });
    expect(new Headers(init.headers).get("content-type")).toBe("application/pdf");
  });

  it("终止 multipart 时把 uploadId 签入查询串", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { abortMultipartUpload } = await import("@/lib/r2");

    await expect(abortMultipartUpload("assets/af_test/file.pdf", "upload id/+"))
      .resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(init.method).toBe("DELETE");
    expect(url).toContain("uploadId=upload%20id%2F%2B");
    expect(headers.get("authorization")).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
  });
});
