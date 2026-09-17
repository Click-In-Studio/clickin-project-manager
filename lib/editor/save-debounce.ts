/**
 * 带上限的 trailing debounce（#515 / #520）。
 *
 * 编辑器自动保存原本是纯 trailing：每个击键都重排计时器，连续打一大段、只要
 * 击键间隔不超过 wait 就永远不落库——丢数据窗口与协作延迟都无界。加 maxWait 后
 * 自第一次 trigger 起最迟 maxWait 必发一次，发完窗口重新计。
 *
 * 只管"什么时候调 fn"，不管 fn 内部的锁/并发：fn 撞锁要不要重排由调用方在 fn
 * 里决定（用 `trigger()` 再排一轮即可）。
 */

export type SaveDebounce = {
  /** 有改动：重排 trailing 计时器，但不超过自窗口起点算的 maxWait */
  trigger(): void;
  /** 计时器是否在挂着 */
  pending(): boolean;
  /** 取消挂着的计时器（不调 fn；窗口起点一并清掉） */
  cancel(): void;
};

export function createSaveDebounce(
  fn: () => void,
  opts: { wait: number; maxWait: number },
): SaveDebounce {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let windowStart: number | null = null;

  const fire = () => {
    timer = null;
    windowStart = null;
    fn();
  };

  return {
    trigger() {
      const now = Date.now();
      if (windowStart == null) windowStart = now;
      if (timer) clearTimeout(timer);
      const untilMax = windowStart + opts.maxWait - now;
      timer = setTimeout(fire, Math.max(0, Math.min(opts.wait, untilMax)));
    },
    pending() { return timer != null; },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      windowStart = null;
    },
  };
}
