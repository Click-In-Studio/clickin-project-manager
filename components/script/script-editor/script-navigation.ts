export type ScriptScrollAnchor = { id: string; top: number };
export type ScriptJump = { kind: "block" | "scene"; id: string; align: ScrollLogicalPosition; viewportTopRatio?: number };

/** 跳转阶段和阅读锚点分别拥有状态；用户滚动可一次取消整条主动定位链。 */
export class ScriptNavigation {
  private pending: ScriptJump | null = null;
  private correction: ScriptJump | null = null;
  private waiting: (ScriptJump & { index: number }) | null = null;
  private anchor: ScriptScrollAnchor | null = null;
  private refresh = false;
  private center: string | null = null;
  private listeners = new Set<() => void>();
  getSnapshot = () => this.waiting;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() { for (const listener of this.listeners) listener(); }
  waitForBlock = (id: string, index: number, align: ScrollLogicalPosition, viewportTopRatio?: number) => {
    this.pending = this.correction = null;
    this.waiting = { kind: "block", id, index, align, viewportTopRatio };
    this.publish();
  };
  takeLoadedTarget = (loaded: ReadonlySet<string>): ScriptJump | null => {
    if (!this.waiting || !loaded.has(this.waiting.id)) return null;
    const target = this.waiting;
    this.waiting = null;
    this.publish();
    return target;
  };
  reconcile = (indexes: ReadonlyMap<string, number>) => {
    if (!this.waiting) return;
    const index = indexes.get(this.waiting.id);
    if (index === undefined) this.cancelJump();
    else if (index !== this.waiting.index) { this.waiting = { ...this.waiting, index }; this.publish(); }
  };
  jump = (target: ScriptJump) => {
    this.pending = target;
    this.correction = null;
    if (this.waiting) { this.waiting = null; this.publish(); }
  };
  readPending = () => this.pending;
  completeJump = (correct: boolean) => {
    if (correct) this.correction = this.pending;
    this.pending = null;
  };
  readCorrection = () => this.correction;
  finishCorrection = () => { this.correction = null; };
  cancelJump = () => {
    this.pending = this.correction = this.waiting = null;
    this.publish();
  };
  preserveAnchor = (anchor: ScriptScrollAnchor | null) => { this.anchor = anchor; };
  readAnchor = () => this.anchor;
  finishAnchor = () => { this.anchor = null; };
  refreshAtAnchor = (anchor: ScriptScrollAnchor | null) => { this.anchor = anchor; this.refresh = true; };
  consumeRefresh = (): boolean => { const refresh = this.refresh; this.refresh = false; return refresh; };
  centerAfterMove = (id: string) => {
    this.cancelJump();
    this.anchor = null;
    this.center = id;
  };
  readCenter = () => this.center;
  takeCenter = () => {
    const center = this.center;
    this.center = null;
    this.anchor = this.correction = null;
    return center;
  };
  stop = () => {
    this.cancelJump();
    this.center = this.anchor = null;
    this.refresh = false;
  };
}
