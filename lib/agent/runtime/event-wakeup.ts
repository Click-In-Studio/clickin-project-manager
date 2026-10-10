// 通知只催促下一次读库；读库期间的多次通知合并为一次补读。
export const EVENT_FALLBACK_MS = 5_000;

export class EventWakeup {
  private pending = false;
  private closed = false;
  private resume: (() => void) | null = null;

  constructor(private readonly signal?: AbortSignal) {
    signal?.addEventListener("abort", this.wake, { once: true });
  }

  readonly wake = (): void => {
    if (this.closed) return;
    this.pending = true;
    this.resume?.();
  };

  async wait(timeoutMs: number): Promise<void> {
    if (!this.pending && !this.closed && !this.signal?.aborted) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.resume = null;
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        this.resume = finish;
      });
    }
    this.pending = false;
  }

  close(): void {
    this.closed = true;
    this.signal?.removeEventListener("abort", this.wake);
    this.resume?.();
  }
}
