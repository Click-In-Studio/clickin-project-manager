import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import { webFetch, webSearch, htmlToText, isPrivateAddress, formatSearchHits, WEB_FETCH_MAX_CHARS } from "@/lib/agent-runtime/web-tools";

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

  it("超长正文截断并标记；重定向跟随；404 报错", async () => {
    process.env.AGENT_WEB_FETCH_ALLOW_PRIVATE = "1";
    const long = await webFetch(`${base}/long`);
    expect(long.text.length).toBe(WEB_FETCH_MAX_CHARS);
    expect(long.truncated).toBe(true);
    expect((await webFetch(`${base}/redirect`)).title).toBe("排练 & 通告");
    await expect(webFetch(`${base}/missing`)).rejects.toThrow("HTTP 404");
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
});
