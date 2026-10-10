export type ScriptWindowRequest = {
  controller: AbortController;
  priority: "foreground" | "background";
  generation: number;
};

/** 前台加载、预取与恢复共用请求槽；旧响应必须同时通过代次与取消检查。 */
export class ScriptWindowRequests {
  private active: ScriptWindowRequest | null = null;
  private generation = 0;
  readGeneration = () => this.generation;
  isBusy = () => this.active !== null;
  isCurrent = (request: ScriptWindowRequest) => !request.controller.signal.aborted && request.generation === this.generation;
  begin = (priority: ScriptWindowRequest["priority"]) => {
    this.cancel();
    const request = { controller: new AbortController(), priority, generation: this.generation };
    this.active = request;
    return request;
  };
  finish = (request: ScriptWindowRequest) => { if (this.active === request) this.active = null; };
  cancel = () => {
    this.active?.controller.abort();
    this.active = null;
    this.generation++;
  };
  cancelBackground = () => { if (this.active?.priority === "background") this.cancel(); };
}
