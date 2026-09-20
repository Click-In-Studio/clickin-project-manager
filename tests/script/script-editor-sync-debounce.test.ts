/**
 * 剧本自动同步的接线守卫（#520）。
 *
 * 行为本身在 tests/wiki/save-debounce.test.ts 锁；这里钉的是 ScriptEditor 真的
 * 用了它、而且用对了——错法都是静默的（同步照常发，只是又变回纯 trailing）：
 *   · 同步计时器走 createSaveDebounce 且带 maxWait，不再是裸 setTimeout(…, 1500)
 *   · 改动只 trigger，不在 effect cleanup 里 cancel（cancel 会清掉 maxWait 窗口起点）
 *   · 撞锁不是 return 丢弃，而是记 deferred、飞完重排
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const src = readFileSync(path.join(process.cwd(), "components/script/ScriptEditor.tsx"), "utf8");

describe("ScriptEditor 自动同步 debounce（#520）", () => {
  it("同步计时器走 createSaveDebounce 并带 maxWait", () => {
    expect(src).toMatch(/import \{ createSaveDebounce \} from "@\/lib\/editor\/save-debounce"/);
    expect(src).toMatch(/createSaveDebounce\([\s\S]*?\{ wait: SYNC_DEBOUNCE_MS, maxWait: SYNC_MAX_WAIT_MS \}\)/);
    expect(src).not.toMatch(/syncTimerRef/);
    expect(src).not.toMatch(/setTimeout\([\s\S]{0,400}?pushPatchRef\.current\(curr\)[\s\S]{0,40}?\}, 1500\)/);
  });

  it("maxWait 上限有意义：小于等于 5s", () => {
    const m = src.match(/const SYNC_MAX_WAIT_MS = (\d+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(5000);
    const w = src.match(/const SYNC_DEBOUNCE_MS = (\d+);/);
    expect(Number(w![1])).toBeLessThan(Number(m![1]));
  });

  it("状态变化的 effect 只 trigger，cleanup 不 cancel", () => {
    const effect = src.match(/useEffect\(\(\) => \{\s*if \(loadState !== "ready"\) return;\s*syncDebounce\.trigger\(\);[\s\S]*?\}, \[blocks, characters, scenes, blockTagMap, loadState, syncDebounce\]\);/);
    expect(effect).not.toBeNull();
    expect(effect![0]).not.toMatch(/cancel\(\)/);
  });

  it("撞锁记 deferred 并在飞完后重排，而不是静默丢弃", () => {
    expect(src).toMatch(/if \(isSyncingRef\.current\) \{ deferredSyncRef\.current = true; return; \}/);
    expect(src).toMatch(/if \(deferredSyncRef\.current\) \{ deferredSyncRef\.current = false; if \(!syncUnmountedRef\.current\) syncDebounce\.trigger\(\); \}/);
  });

  it("卸载后在飞的那笔不再重排计时器", () => {
    expect(src).toMatch(/\(\) => \{ syncUnmountedRef\.current = true; syncDebounce\.cancel\(\); \}/);
  });
});
