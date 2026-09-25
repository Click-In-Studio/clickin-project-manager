import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import { webFetch, webSearch, htmlToText, isPrivateAddress, formatSearchHits, resolvePublicAddresses, sanitizeText, isTextualContentType, WEB_FETCH_MAX_CHARS } from "@/lib/agent/runtime/web-tools";

// 假 DNS：让「域名」形式的 URL 也能落到本地 server，从而真正走建连层的 lookup 回调（#683）。
// 字面 IP 不触发 lookup、localhost 在 lookup 前就被拒——只用它们的用例永远碰不到那条路径。
const dnsTable = vi.hoisted(() => new Map<string, Array<{ address: string; family: number }>>());
vi.mock("node:dns/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...real,
    lookup: async (host: string, opts?: unknown) => {
      const hit = dnsTable.get(host);
      if (hit) return hit;
      return (real.lookup as (h: string, o?: unknown) => Promise<unknown>)(host, opts);
    },
  };
});

// 网关退役后模型的联网能力由这两个工具承接：抓页要能抽正文、挡内网、截长文；搜索走 Brave。

describe("web.fetch", () => {
  let server: http.Server;
  let base: string;
  let port = 0;
  const hits: string[] = [];
  const prevAllow = process.env.AGENT_WEB_FETCH_ALLOW_PRIVATE;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(`${req.headers.host ?? ""}${req.url ?? ""}`);
      if (req.url === "/page") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<!doctype html><html><head><title> 排练 &amp; 通告 </title><style>p{}</style><script>alert(1)</script></head>
          <body><nav>菜单</nav><h1>第一幕</h1><p>灯光&nbsp;提示：<b>暗场</b></p><ul><li>一</li><li>二</li></ul><!-- 注释 --></body></html>`);
      } else if (req.url === "/long") {
        res.setHeader("content-type", "text/plain");
        res.end("x".repeat(WEB_FETCH_MAX_CHARS + 500));
      } else if (req.url === "/redirect") {
        res.writeHead(302, { location: `${base}/page` });
        res.end();
      } else if (req.url === "/redirect-private") {
        // 同一台服务器换个主机名：白名单只放 127.0.0.1，localhost 不在 → 这一跳必须在建连前被拒
        res.writeHead(302, { location: `http://localhost:${port}/page` });
        res.end();
      } else if (req.url === "/paper.pdf") {
        res.writeHead(200, { "content-type": "application/pdf", "content-length": String(3 * 1024 * 1024) });
        res.end(Buffer.concat([Buffer.from("%PDF-1.7\n%"), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x00, 0x00, 0x01])]));
      } else if (req.url === "/untyped-binary") {
        res.writeHead(200); // 没有 content-type：只能靠嗅探
        res.end(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x08]));
      } else if (req.url === "/dirty-text") {
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(Buffer.concat([Buffer.from("前\u0001后"), Buffer.from([0x00]), Buffer.from("\t保留\n换行"), Buffer.from([0xed, 0xa0, 0x80])]));
      } else {
        res.writeHead(404); res.end("nope");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (prevAllow === undefined) delete process.env.AGENT_WEB_FETCH_ALLOW_PRIVATE; else process.env.AGENT_WEB_FETCH_ALLOW_PRIVATE = prevAllow;
  });

  it("内网地址默认拒绝（SSRF）；测试开关放行", async () => {
    delete process.env.AGENT_WEB_FETCH_ALLOW_PRIVATE;
    await expect(webFetch(`${base}/page`)).rejects.toThrow("不允许抓取内网地址");
    await expect(webFetch("http://localhost/x")).rejects.toThrow("不允许抓取内网地址");
    await expect(webFetch("ftp://example.com/x")).rejects.toThrow("只支持 http/https");
    await expect(webFetch("not a url")).rejects.toThrow("URL 不合法");
  });

  it("HTML → 标题 + 正文：去 script/style/注释，块级换行，实体解码", async () => {
    process.env.AGENT_WEB_FETCH_ALLOW_PRIVATE = "1";
    const p = await webFetch(`${base}/page`);
    expect(p.title).toBe("排练 & 通告");
    expect(p.text).not.toContain("alert");
    expect(p.text).not.toContain("注释");
    expect(p.text).toContain("第一幕");
    expect(p.text).toContain("灯光 提示：暗场");
    expect(p.text.split("\n")).toEqual(expect.arrayContaining(["一", "二"]));
    expect(p.truncated).toBe(false);
  });

  it("重定向到白名单外的内网主机：在发请求之前被拒（不是拿到响应后才拒）", async () => {
    process.env.AGENT_WEB_FETCH_ALLOW_PRIVATE = "127.0.0.1";
    hits.length = 0;
    await expect(webFetch(`${base}/redirect-private`)).rejects.toThrow("不允许抓取内网地址");
    expect(hits).toEqual([`127.0.0.1:${port}/redirect-private`]); // localhost 那一跳从未到达服务器
  });

  it("二进制不当文本读（#685）：PDF / 无 content-type 的二进制都回可读错误；文本里的 NUL 与控制字符被清掉", async () => {
    process.env.AGENT_WEB_FETCH_ALLOW_PRIVATE = "1";
    await expect(webFetch(`${base}/paper.pdf`)).rejects.toThrow(/PDF文件（application\/pdf，约 3\.0 MB）.*上传为项目资产/);
    await expect(webFetch(`${base}/untyped-binary`)).rejects.toThrow("二进制文件（类型未知");
    const dirty = await webFetch(`${base}/dirty-text`);
    expect(dirty.text).not.toContain("\u0000");
    expect(dirty.text).not.toContain("\u0001");
    expect(dirty.text).toContain("前后");
    expect(dirty.text).toContain("\t保留\n换行");
    expect(dirty.text.isWellFormed()).toBe(true);
  });

  it("超长正文截断并标记；重定向跟随；404 报错", async () => {
    process.env.AGENT_WEB_FETCH_ALLOW_PRIVATE = "1";
    const long = await webFetch(`${base}/long`);
    expect(long.text.length).toBe(WEB_FETCH_MAX_CHARS);
    expect(long.truncated).toBe(true);
    expect((await webFetch(`${base}/redirect`)).title).toBe("排练 & 通告");
    await expect(webFetch(`${base}/missing`)).rejects.toThrow("HTTP 404");
  });
});

describe("web.fetch 建连层 lookup（#683）", () => {
  let server: http.Server;
  let port = 0;
  const prevAllow = process.env.AGENT_WEB_FETCH_ALLOW_PRIVATE;
  beforeAll(async () => {
    server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<title>建连</title><p>正文</p>"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    dnsTable.set("hot.web-fetch.test", [{ address: "127.0.0.1", family: 4 }]);
    dnsTable.set("mixed.web-fetch.test", [{ address: "10.0.0.1", family: 4 }, { address: "fd00::1", family: 6 }, { address: "93.184.216.34", family: 4 }]);
    dnsTable.set("priv.web-fetch.test", [{ address: "10.0.0.1", family: 4 }, { address: "fd00::1", family: 6 }]);
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    dnsTable.clear();
    if (prevAllow === undefined) delete process.env.AGENT_WEB_FETCH_ALLOW_PRIVATE; else process.env.AGENT_WEB_FETCH_ALLOW_PRIVATE = prevAllow;
  });

  it("域名 URL 能抓到正文：lookup 回调必须按 Node autoSelectFamily 的 { all: true } 契约回数组", async () => {
    process.env.AGENT_WEB_FETCH_ALLOW_PRIVATE = "hot.web-fetch.test";
    const p = await webFetch(`http://hot.web-fetch.test:${port}/page`);
    expect(p.title).toBe("建连");
    expect(p.text).toContain("正文");
  });

  it("解析结果逐地址过滤：公网混私网只留公网；全是私网才拒", async () => {
    delete process.env.AGENT_WEB_FETCH_ALLOW_PRIVATE;
    await expect(resolvePublicAddresses("mixed.web-fetch.test")).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
    await expect(resolvePublicAddresses("priv.web-fetch.test")).rejects.toThrow("不允许抓取内网地址");
    await expect(webFetch(`http://priv.web-fetch.test:${port}/page`)).rejects.toThrow("不允许抓取内网地址");
    // 不用真实的 NXDOMAIN：VPN fake-ip 之类的本机环境会把任何名字都解出地址，改让假 DNS 回空
    dnsTable.set("nx.web-fetch.test", []);
    await expect(resolvePublicAddresses("nx.web-fetch.test")).rejects.toThrow("域名无法解析");
  });
});

describe("isPrivateAddress", () => {
  it("覆盖 v4 私网/环回/链路本地/CGNAT 与 v6 环回/ULA/映射", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("web.search（Brave，fetch 打桩）", () => {
  const prevKey = process.env.BRAVE_API_KEY;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevKey === undefined) delete process.env.BRAVE_API_KEY; else process.env.BRAVE_API_KEY = prevKey;
  });

  it("没配 key → 明确告诉模型不能联网", async () => {
    delete process.env.BRAVE_API_KEY;
    await expect(webSearch("x")).rejects.toThrow("BRAVE_API_KEY");
  });

  it("带 X-Subscription-Token 调 Brave，结果映射为 标题/链接/摘要（摘要去 HTML 标签）", async () => {
    process.env.BRAVE_API_KEY = "test-token";
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", async (u: URL | string, init?: RequestInit) => {
      calls.push({ url: String(u), headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify({ web: { results: [
        { title: "音乐剧《汉密尔顿》", url: "https://example.com/h", description: "百老汇<strong>音乐剧</strong>……" },
        { title: "b", url: "https://example.com/b", description: "d2" },
      ] } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const hits = await webSearch("汉密尔顿 音乐剧", 1);
    expect(calls[0].url).toContain("api.search.brave.com/res/v1/web/search?q=");
    expect(calls[0].url).toContain("count=1");
    expect(calls[0].headers["X-Subscription-Token"]).toBe("test-token");
    expect(hits).toEqual([{ title: "音乐剧《汉密尔顿》", url: "https://example.com/h", snippet: "百老汇 音乐剧 ……" }]);
    expect(formatSearchHits("q", hits)).toContain("1. 音乐剧《汉密尔顿》\n   https://example.com/h");
    expect(formatSearchHits("q", [])).toContain("没有搜索结果");
  });

  it("配额用尽（429）→ 可读错误", async () => {
    process.env.BRAVE_API_KEY = "t";
    vi.stubGlobal("fetch", async () => new Response("", { status: 429 }));
    await expect(webSearch("x")).rejects.toThrow("配额用尽");
  });
});

describe("htmlToText 不依赖网络", () => {
  it("实体与数字实体解码", () => {
    expect(htmlToText("<p>A &lt; B &#20320;&#x597D;</p>").text).toBe("A < B 你好");
  });

  it("数字实体的非法码点（0 / 代理区 / 超限）解成 U+FFFD，不产 NUL、不产孤立代理、不抛（#685）", () => {
    expect(htmlToText("<p>a&#0;b</p>").text).toBe("a�b");
    expect(htmlToText("<p>a&#xD800;b</p>").text).toBe("a�b");
    expect(htmlToText("<p>a&#1114112;b</p>").text).toBe("a�b");
    expect(htmlToText("<p>&#x1F3AD;</p>").text).toBe("🎭"); // 合法的增补平面码点照常
  });

  it("sanitizeText / isTextualContentType", () => {
    expect(sanitizeText("a\u0000b\u0007c\td\ne\u007Ff")).toBe("abc\td\nef");
    expect(sanitizeText("x\uD800y")).toBe("x�y");
    expect(sanitizeText("x\uDC00y")).toBe("x�y");
    expect(sanitizeText("🎭")).toBe("🎭"); // 成对代理不动
    for (const t of ["text/html; charset=utf-8", "text/plain", "application/json", "application/xhtml+xml", "application/ld+json", "image/svg+xml"]) {
      expect(isTextualContentType(t), t).toBe(true);
    }
    for (const t of ["application/pdf", "image/png", "application/octet-stream", "application/zip", "audio/mpeg"]) {
      expect(isTextualContentType(t), t).toBe(false);
    }
  });
});
