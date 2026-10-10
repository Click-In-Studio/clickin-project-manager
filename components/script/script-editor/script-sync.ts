import { createSaveDebounce } from "@/lib/editor/save-debounce";
import { ScriptPatchConflict } from "@/lib/script/script-patch-basis";
import { hasScriptSaveOperations, type ScriptSaveBatch } from "./script-save-batch";
import type { ScriptDocument } from "./script-document";

export type ScriptSyncOptions = {
  canWrite: () => boolean;
  ready: () => boolean;
  send: (batch: ScriptSaveBatch) => Promise<number>;
  afterSave: (batch: ScriptSaveBatch) => Promise<void>;
  onConflict: () => void;
};

/** 保存调度只拥有在途、重试和暂停；内容及依据通过正文维护者成批确认。 */
export class ScriptSync {
  private options: ScriptSyncOptions;
  private running: Promise<boolean> | null = null;
  private suspended = false;
  private stopped = false;
  private deferred = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private clientSeq = 0;
  private serverSeq = 0;
  private discardPending = false;
  private snapshot = { waitingForNetwork: false, conflict: false };
  private listeners = new Set<() => void>();
  private debounce = createSaveDebounce(() => { void this.save(); }, { wait: 1500, maxWait: 5000 });

  constructor(private document: ScriptDocument, options: ScriptSyncOptions) { this.options = options; }
  configure(options: ScriptSyncOptions) { this.options = options; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<typeof this.snapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  isSaving = () => this.running !== null;
  isSuspended = () => this.suspended;
  getServerSeq = () => this.serverSeq;
  observeServerSeq = (seq: number) => { this.serverSeq = Math.max(this.serverSeq, seq); };
  needsConflictReload = () => this.discardPending;
  isStopped = () => this.stopped;
  trigger = () => { if (!this.stopped && !this.suspended) this.debounce.trigger(); };
  waitForIdle = async () => { if (this.running) await this.running; };
  private cancelRetry() { if (this.retry !== null) clearTimeout(this.retry); this.retry = null; }
  pause = () => {
    this.suspended = true;
    this.debounce.cancel();
    this.deferred = false;
    this.cancelRetry();
  };
  resume = () => { this.suspended = false; this.trigger(); };
  resetAfterRecovery = () => {
    this.serverSeq = 0;
    this.discardPending = false;
    this.publish({ waitingForNetwork: false });
  };
  dismissConflict = () => { this.publish({ conflict: false }); };

  start = () => {
    this.stopped = false;
    let previous = this.document.getSnapshot();
    const unsubscribe = this.document.subscribe(() => {
      const next = this.document.getSnapshot();
      if (next.blocks !== previous.blocks || next.characters !== previous.characters || next.scenes !== previous.scenes || next.tags !== previous.tags) this.trigger();
      previous = next;
    });
    return () => {
      this.stopped = true;
      unsubscribe();
      this.debounce.cancel();
      this.cancelRetry();
    };
  };

  save = (recovering = false): Promise<boolean> => {
    if (this.stopped || this.suspended && !recovering) return Promise.resolve(false);
    if (!this.options.canWrite() && !recovering) return Promise.resolve(true);
    if (!this.options.ready()) return Promise.resolve(false);
    if (this.running) { this.deferred = true; return this.running; }
    const batch = this.document.prepareSave(++this.clientSeq);
    if (!batch) return Promise.resolve(false);
    if (!hasScriptSaveOperations(batch)) return Promise.resolve(true);
    const options = this.options;
    // 先占在途槽，再执行传输；即使传输同步触发保存也不能并发。
    this.running = Promise.resolve().then(async () => {
      try {
        const seq = await options.send(batch);
        this.observeServerSeq(seq);
        this.document.acknowledge(batch);
        this.cancelRetry();
        this.publish({ waitingForNetwork: false });
        if (!this.stopped) await options.afterSave(batch);
        return true;
      } catch (error) {
        if (error instanceof ScriptPatchConflict) {
          this.discardPending = true;
          this.publish({ conflict: true });
          if (!recovering && !this.suspended && !this.stopped) queueMicrotask(() => options.onConflict());
          return true;
        }
        this.publish({ waitingForNetwork: true });
        this.cancelRetry();
        if (!this.stopped && !this.suspended) this.retry = setTimeout(() => { this.retry = null; this.trigger(); }, 2000);
        return false;
      } finally {
        this.running = null;
        if (this.deferred) { this.deferred = false; this.trigger(); }
      }
    });
    return this.running;
  };

  /** 模式切换、标记提交与恢复共用串行入口，始终读取等待后的最新内容。 */
  flush = async (recovering = false): Promise<boolean> => {
    this.debounce.cancel();
    await this.waitForIdle();
    this.deferred = false;
    this.debounce.cancel();
    for (;;) {
      if (!await this.save(recovering)) return false;
      if (this.discardPending) return true;
      if (!this.document.hasPending()) return true;
      if (this.stopped || this.suspended && !recovering || !this.options.canWrite() && !recovering) return false;
    }
  };
}
