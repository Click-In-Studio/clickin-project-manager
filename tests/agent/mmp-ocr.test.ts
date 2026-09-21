// #453 MMP 接入首例：ocr.structured 薄封装 + 计费真值（#618）。
// 客户端用假 fetch 注入，不打真服务：钉 ①媒体句柄第二次起走 refOr；②计费取 render+ocr，
// 不含 fetch / 冷启动，缓存命中 0；③缺 timings 按页估算并标记；④shouldFallback 类错误
// → unavailable，bad_request → 非 unavailable；⑤未配置 → unavailable。

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { MmpClient } from "@mmp/client";
import { ocrPages, billableMsOf, clearMmpMediaCacheForTests } from "@/lib/mmp/ocr";
import { getMmpClient } from "@/lib/mmp/client";
import { creditsFromMmpCompute, MMP_GPU_USD_PER_HOUR, CREDIT_USD } from "@/lib/account/plan";

type Call = { url: string; body: Record<string, unknown> | null };

function fakeClient(respond: (call: Call, n: number) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const call = { url, body };
    calls.push(call);
    const r = respond(call, calls.length);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { client: new MmpClient({ baseUrl: "https://mmp.test", apiKey: "k", fetch, retries: 0 }), calls };
}

function doneBody(over: Partial<Record<string, unknown>> = {}) {
  return {
    job_id: "gpu-lab-01", type: "ocr.structured", status: "done", media_id: "sha256:abc", cached: false,
    source: { tier: "gpu-fast", engine: "pp-ocrv6", engine_version: "1", generated_at: "2026-09-21T00:00:00Z", degraded: false, params: {} },
    result: {
      page_count: 3,
      pages: [{ page: 2, tier: "gpu-fast", text: "阿兰：你到底把信藏在哪儿了？", quality: { lines: 1, chars: 13, mean_score: 0.98 }, flags: [] }],
      suggest_upgrade_pages: [],
    },
    timings_ms: { fetch: 5000, render: 15, ocr: 812, total: 44452 },
    ...over,
  };
}

const ENV_BEFORE = { url: process.env.MMP_BASE_URL, key: process.env.MMP_API_KEY };
afterAll(() => {
  if (ENV_BEFORE.url === undefined) delete process.env.MMP_BASE_URL; else process.env.MMP_BASE_URL = ENV_BEFORE.url;
  if (ENV_BEFORE.key === undefined) delete process.env.MMP_API_KEY; else process.env.MMP_API_KEY = ENV_BEFORE.key;
});
beforeEach(() => clearMmpMediaCacheForTests());

describe("ocrPages：媒体句柄与结果", () => {
  it("首次 get(url)，第二次起 refOr(media_id, get(url))；结果按页返回", async () => {
    const { client, calls } = fakeClient(() => ({ status: 200, body: doneBody() }));
    const a = await ocrPages({ fileId: "f1", url: "https://r2/x.pdf?sig", pages: [2], tier: "gpu-fast" }, { client });
    expect(a.status).toBe("ok");
    if (a.status !== "ok") return;
    expect(a.pages[0].text).toContain("阿兰");
    expect(a.pageCount).toBe(3);
    expect(a.mediaId).toBe("sha256:abc");
    expect(calls[0].body?.media).toEqual({ get: { url: "https://r2/x.pdf?sig" } });
    expect(calls[0].body?.tier).toBe("gpu-fast");
    expect((calls[0].body?.params as { pages: number[] }).pages).toEqual([2]);

    await ocrPages({ fileId: "f1", url: "https://r2/x.pdf?sig2", pages: [3, 2, 2], tier: "gpu", lang: "en" }, { client });
    const m = calls[1].body?.media as Record<string, unknown>;
    expect(m.ref).toBe("sha256:abc");
    expect(m.get).toEqual({ url: "https://r2/x.pdf?sig2" });
    expect((calls[1].body?.params as { pages: number[]; lang: string })).toEqual({ pages: [2, 3], lang: "en" });
  });

  it("计费真值 = render + ocr（不含 fetch 与冷启动）；cached → 0", async () => {
    const { client } = fakeClient(() => ({ status: 200, body: doneBody() }));
    const a = await ocrPages({ fileId: "f2", url: "u", pages: [2], tier: "gpu-fast" }, { client });
    expect(a.status === "ok" && a.computeMs).toBe(827);
    expect(a.status === "ok" && a.computeEstimated).toBe(false);

    const { client: c2 } = fakeClient(() => ({ status: 200, body: doneBody({ cached: true }) }));
    const b = await ocrPages({ fileId: "f3", url: "u", pages: [2], tier: "gpu-fast" }, { client: c2 });
    expect(b.status === "ok" && b.cached).toBe(true);
    expect(b.status === "ok" && b.computeMs).toBe(0);
  });

  it("缺 timings_ms → 按页估算并标记 computeEstimated", async () => {
    const { client } = fakeClient(() => ({ status: 200, body: doneBody({ timings_ms: undefined }) }));
    const a = await ocrPages({ fileId: "f4", url: "u", pages: [2], tier: "gpu" }, { client });
    expect(a.status === "ok" && a.computeEstimated).toBe(true);
    expect(a.status === "ok" && a.computeMs).toBe(6000);
    expect(billableMsOf({ total: 100 }, "gpu-fast", 3)).toEqual({ ms: 3000, estimated: true });
    expect(billableMsOf({ render: 10, ocr: 20, fetch: 999 }, "gpu", 3)).toEqual({ ms: 30, estimated: false });
  });

  it("no_node → unavailable=true；bad_request → unavailable=false；未配置 → unavailable", async () => {
    const { client } = fakeClient(() => ({ status: 503, body: { error: "no_node", message: "no node" } }));
    const a = await ocrPages({ fileId: "f5", url: "u", pages: [1], tier: "gpu-fast" }, { client });
    expect(a).toMatchObject({ status: "error", code: "no_node", unavailable: true });

    const { client: c2 } = fakeClient(() => ({ status: 400, body: { error: "bad_request", message: "pages" } }));
    const b = await ocrPages({ fileId: "f6", url: "u", pages: [1], tier: "gpu-fast" }, { client: c2 });
    expect(b).toMatchObject({ status: "error", code: "bad_request", unavailable: false });

    const c = await ocrPages({ fileId: "f7", url: "u", pages: [1], tier: "gpu-fast" }, { client: null });
    expect(c).toMatchObject({ status: "error", code: "not_configured", unavailable: true });
  });
});

describe("getMmpClient：按 env 建客户端", () => {
  it("缺 MMP_BASE_URL → null；配置后同 env 复用同一实例", () => {
    delete process.env.MMP_BASE_URL;
    expect(getMmpClient()).toBeNull();
    process.env.MMP_BASE_URL = "https://mmp.test";
    const a = getMmpClient();
    expect(a).toBeInstanceOf(MmpClient);
    expect(getMmpClient()).toBe(a);
    process.env.MMP_API_KEY = "changed";
    expect(getMmpClient()).not.toBe(a);
  });
});

describe("creditsFromMmpCompute（#618）", () => {
  it("cpu 档恒 0；gpu 档 = 毫秒 × 每小时成本 折 credit，量级 ≈ 250 credit/GPU 秒", () => {
    expect(creditsFromMmpCompute("cpu", 60_000)).toBe(0);
    expect(creditsFromMmpCompute("gpu", 0)).toBe(0);
    expect(creditsFromMmpCompute("gpu", NaN)).toBe(0);
    const perSec = creditsFromMmpCompute("gpu", 1000);
    expect(perSec).toBe(Math.round((MMP_GPU_USD_PER_HOUR / 3600) / CREDIT_USD));
    expect(perSec).toBeGreaterThan(200);
    expect(perSec).toBeLessThan(300);
    expect(creditsFromMmpCompute("gpu-fast", 827)).toBe(Math.round(perSec * 0.827));
  });
});
