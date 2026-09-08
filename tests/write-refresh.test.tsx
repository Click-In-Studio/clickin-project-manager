import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 两套 vitest 配置都会捞到 .test.tsx：主配置是 node 环境（没有 window），
// ui 配置是 jsdom。write-refresh 有 SSR 保护（typeof window === "undefined" 直接
// 返回），所以在 node 下补一个 window 桩，让两边跑的是同一条逻辑。
if (typeof globalThis.window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {};
}

type Router = { refresh: () => void };

async function freshModule() {
  vi.resetModules();
  return import("@/lib/write-refresh");
}

let refresh: ReturnType<typeof vi.fn>;
let router: Router;

beforeEach(() => {
  vi.useFakeTimers();
  refresh = vi.fn();
  router = { refresh } as Router;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("#416 写后失效 router cache", () => {
  it("写成功后安排 refresh —— 这是 staleTimes 开启后不让用户的写被打回的唯一通道", async () => {
    const m = await freshModule();
    m.registerWriteRefreshRouter(router as never);

    global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    await m.writeFetch("/api/x", { method: "POST" });

    // 去抖窗口内不该打
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("写失败不刷新", async () => {
    const m = await freshModule();
    m.registerWriteRefreshRouter(router as never);

    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response);
    await m.writeFetch("/api/x", { method: "POST" });

    vi.advanceTimersByTime(1000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("一次操作里连发的多个写合并成一次往返", async () => {
    const m = await freshModule();
    m.registerWriteRefreshRouter(router as never);

    global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    await m.writeFetch("/api/a", { method: "POST" });
    vi.advanceTimersByTime(100);
    await m.writeFetch("/api/b", { method: "PATCH" });
    vi.advanceTimersByTime(100);
    await m.writeFetch("/api/c", { method: "DELETE" });

    vi.advanceTimersByTime(300);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("没有注册 router 时不抛（SSR / AppShell 未挂载）", async () => {
    const m = await freshModule();
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    await m.writeFetch("/api/x", { method: "POST" });
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
  });

  it("注销后不再刷新——注销函数只认自己注册的那个 router", async () => {
    const m = await freshModule();
    const unregister = m.registerWriteRefreshRouter(router as never);

    const later = { refresh: vi.fn() };
    m.registerWriteRefreshRouter(later as never);
    // 旧 router 的注销不该把新注册的踢掉
    unregister();

    global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    await m.writeFetch("/api/x", { method: "POST" });
    vi.advanceTimersByTime(300);

    expect(refresh).not.toHaveBeenCalled();
    expect(later.refresh).toHaveBeenCalledTimes(1);
  });

  it("writeFetch 原样透传 Response —— 调用点的 res.ok / res.json 语义不变", async () => {
    const m = await freshModule();
    m.registerWriteRefreshRouter(router as never);

    const body = { id: "t1" };
    const res = { ok: true, status: 201, json: async () => body } as unknown as Response;
    global.fetch = vi.fn().mockResolvedValue(res);

    const got = await m.writeFetch("/api/x", { method: "POST" });
    expect(got).toBe(res);
    expect(got.status).toBe(201);
    await expect(got.json()).resolves.toEqual(body);
  });

  it("refreshNow 立即刷新并吃掉待发的去抖——不会刷两趟", async () => {
    const m = await freshModule();
    m.registerWriteRefreshRouter(router as never);

    global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    await m.writeFetch("/api/x", { method: "DELETE" });
    // 调用点自己还依赖 refresh 重投喂界面（例如删除后没有本地 setState）
    m.refreshNow();
    expect(refresh).toHaveBeenCalledTimes(1);

    // 待发的那次已被吃掉，时钟推过去也不该再有第二趟
    vi.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
