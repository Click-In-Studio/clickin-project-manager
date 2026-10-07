// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { readScriptPersonalMode, useStoredScriptPersonalMode, writeScriptPersonalMode } from "@/components/script/script-editor/personal-mode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ModeProbe({ scriptId = "script-a" }: { scriptId?: string }) {
  const [mode, , ready] = useStoredScriptPersonalMode(scriptId);
  return createElement("output", null, ready ? mode : "locked");
}

describe("剧本个人编辑 / 只读模式存储", () => {
  beforeEach(() => localStorage.clear());

  it("默认编辑，并按剧本分别记忆", () => {
    expect(readScriptPersonalMode("script-a")).toBe("edit");
    writeScriptPersonalMode("script-a", "read");
    expect(readScriptPersonalMode("script-a")).toBe("read");
    expect(readScriptPersonalMode("script-b")).toBe("edit");
  });

  it("异常旧值不会放大为编辑以外的新状态", () => {
    localStorage.setItem("clickin:script-personal-mode:script-a", "unexpected");
    expect(readScriptPersonalMode("script-a")).toBe("edit");
  });

  it("SSR 首帧保持锁定，挂载后再恢复 localStorage，避免 hydration 前短暂可写", () => {
    writeScriptPersonalMode("script-a", "read");
    expect(renderToString(createElement(ModeProbe))).toContain("locked");

    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(createElement(ModeProbe)));
    expect(container.textContent).toBe("read");
    act(() => root.unmount());
  });

  it("切换剧本时按新 id 恢复，不复用上一剧本的模式", () => {
    writeScriptPersonalMode("script-a", "read");
    writeScriptPersonalMode("script-b", "edit");
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(createElement(ModeProbe, { scriptId: "script-a" })));
    expect(container.textContent).toBe("read");
    act(() => root.render(createElement(ModeProbe, { scriptId: "script-b" })));
    expect(container.textContent).toBe("edit");
    act(() => root.unmount());
  });
});
