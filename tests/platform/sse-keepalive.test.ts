import { describe, it, expect, afterAll } from "vitest";
import { registerSSEKeepalive, sseKeepaliveTick } from "@/lib/sse-keepalive";
import { registerSSE, registerCueSSE } from "@/lib/server-cache";
import { registerWikiSSE, registerWikiLibrarySSE, stopCollabListenerForTests } from "@/lib/wiki/collab";
import { shortId } from "../_support/factories";

// #465：协作 SSE 周期注释帧——空闲流不再被 nginx 默认 60s read_timeout 掐断。
// 定时器本身是 setInterval(25s)，测试直接调 sseKeepaliveTick() 验证扫描逻辑。

function collect(): { frames: string[]; push: (f: string) => void } {
  const frames: string[] = [];
  return { frames, push: (f: string) => frames.push(f) };
}

afterAll(async () => {
  await stopCollabListenerForTests();
});

describe("registerSSEKeepalive", () => {
  it("tick 给所有在册 push 发注释帧，释放后不再发", () => {
    const a = collect();
    const b = collect();
    const releaseA = registerSSEKeepalive(a.push);
    const releaseB = registerSSEKeepalive(b.push);

    sseKeepaliveTick();
    expect(a.frames).toEqual([": ping\n\n"]);
    expect(b.frames).toEqual([": ping\n\n"]);

    releaseA();
    sseKeepaliveTick();
    expect(a.frames).toHaveLength(1);
    expect(b.frames).toHaveLength(2);
    releaseB();
  });

  it("同一 push 双注册只发一份 ping；两个释放都调完才移除（wiki 双 topic 场景）", () => {
    const c = collect();
    const release1 = registerSSEKeepalive(c.push);
    const release2 = registerSSEKeepalive(c.push);

    sseKeepaliveTick();
    expect(c.frames).toHaveLength(1); // 双注册不双发

    release1();
    sseKeepaliveTick();
    expect(c.frames).toHaveLength(2); // 还剩一个引用，继续发

    release2();
    sseKeepaliveTick();
    expect(c.frames).toHaveLength(2);
  });

  it("释放函数幂等：push 错误路径与 stream cancel 各调一次不会多减引用", () => {
    const c = collect();
    const release1 = registerSSEKeepalive(c.push);
    const release2 = registerSSEKeepalive(c.push);

    release1();
    release1(); // 同一 cleanup 被调两次（push catch + cancel()）
    sseKeepaliveTick();
    expect(c.frames).toHaveLength(1); // release2 的引用仍在

    release2();
  });

  it("某个 push 抛错不影响其他连接收到 ping", () => {
    const bad = registerSSEKeepalive(() => { throw new Error("broken pipe"); });
    const ok = collect();
    const release = registerSSEKeepalive(ok.push);

    expect(() => sseKeepaliveTick()).not.toThrow();
    expect(ok.frames).toEqual([": ping\n\n"]);

    bad();
    release();
  });
});

describe("三条协作注册表接入 keepalive", () => {
  it("registerSSE（script）：注册即在扫描名单，cleanup 后退出", () => {
    const c = collect();
    const cancel = registerSSE(shortId(), shortId(), "conn1", "client1", c.push);
    sseKeepaliveTick();
    expect(c.frames).toHaveLength(1);
    cancel();
    sseKeepaliveTick();
    expect(c.frames).toHaveLength(1);
  });

  it("registerCueSSE：同上", () => {
    const c = collect();
    const cancel = registerCueSSE(shortId(), "client1", c.push);
    sseKeepaliveTick();
    expect(c.frames).toHaveLength(1);
    cancel();
    sseKeepaliveTick();
    expect(c.frames).toHaveLength(1);
  });

  it("registerWikiSSE + registerWikiLibrarySSE 共用 push：一份 ping，双 cleanup 后退出", () => {
    const c = collect();
    const wikiId = shortId();
    const prodId = shortId();
    const cancelDoc = registerWikiSSE(wikiId, "conn1", c.push);
    const cancelLibrary = registerWikiLibrarySSE(prodId, "conn1", c.push);

    sseKeepaliveTick();
    expect(c.frames).toHaveLength(1); // 双 topic 注册不双发

    cancelDoc();
    sseKeepaliveTick();
    expect(c.frames).toHaveLength(2); // library 侧还在

    cancelLibrary();
    sseKeepaliveTick();
    expect(c.frames).toHaveLength(2);
  });
});
