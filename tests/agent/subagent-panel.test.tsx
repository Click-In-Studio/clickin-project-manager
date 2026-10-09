// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import SubagentPanel from "@/components/agent/SubagentPanel";

class StatusStream {
  static current: StatusStream;
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    StatusStream.current = this;
  }
  send(parentRunId: string | null, parentStatus: string | null) {
    this.onmessage?.({
      data: JSON.stringify({ subagents: [], parentRunId, parentStatus }),
    });
  }
}

describe("子助理状态流接回主会话", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("EventSource", StatusStream);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    const stream = StatusStream.current;
    await act(async () => root.unmount());
    expect(stream.close).toHaveBeenCalledOnce();
    expect(stream.onmessage).toBeNull();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("即使错过 running 状态，新的已完成轮次仍刷新历史；重复帧不重复接回", async () => {
    const onParentRun = vi.fn(async () => true);
    await act(async () =>
      root.render(
        <SubagentPanel sessionKey="个人会话" onParentRun={onParentRun} />,
      ),
    );
    await act(async () => StatusStream.current.send(null, null));
    expect(onParentRun).not.toHaveBeenCalled();
    await act(async () => StatusStream.current.send("后台轮次1", null));
    expect(onParentRun).toHaveBeenLastCalledWith("done");
    await act(async () => StatusStream.current.send("后台轮次1", null));
    expect(onParentRun).toHaveBeenCalledOnce();
    await act(async () => StatusStream.current.send("后台轮次2", "running"));
    expect(onParentRun).toHaveBeenLastCalledWith("running");
    await act(async () => StatusStream.current.send("后台轮次2", null));
    expect(onParentRun).toHaveBeenLastCalledWith("done");
    expect(onParentRun).toHaveBeenCalledTimes(3);
  });

  it("加载历史或接流期间暂存最新轮次，主面板空闲后仍能接回", async () => {
    const busy = vi.fn(async () => false);
    await act(async () =>
      root.render(<SubagentPanel sessionKey="个人会话" onParentRun={busy} />),
    );
    await act(async () => StatusStream.current.send("后台轮次3", null));
    expect(busy).toHaveBeenCalledWith("done");
    const ready = vi.fn(async () => true);
    await act(async () =>
      root.render(<SubagentPanel sessionKey="个人会话" onParentRun={ready} />),
    );
    expect(ready).toHaveBeenCalledWith("done");
    await act(async () => StatusStream.current.send("后台轮次3", null));
    expect(ready).toHaveBeenCalledOnce();
  });
});
