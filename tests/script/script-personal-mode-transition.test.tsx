// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DISPLAY, type DisplaySettings } from "@/components/script/script-editor/display-settings";
import { useScriptPersonalModeTransition } from "@/components/script/script-editor/use-script-personal-mode-transition";
import type { ScriptPersonalMode } from "@/components/script/script-editor/personal-mode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const closeMenu = vi.fn();
const resetInteractions = vi.fn();
const preserveScrollAnchor = vi.fn();

function Probe({ canEdit, flush }: { canEdit: boolean; flush: () => Promise<boolean> }) {
  const [mode, setMode] = useState<ScriptPersonalMode>("edit");
  const [rehearsalMode, setRehearsalMode] = useState(false);
  const [, setDisplay] = useState<DisplaySettings>(DEFAULT_DISPLAY);
  const transition = useScriptPersonalModeTransition({
    scriptId: "script-a",
    baseCanEdit: canEdit,
    personalMode: mode,
    rehearsalMode,
    setPersonalMode: setMode,
    setRehearsalMode,
    setDisplay,
    flushPendingPatch: flush,
    captureScrollAnchor: () => ({ id: "b1", top: 120 }),
    preserveScrollAnchor,
    resetInteractions,
    closeMenu,
  });
  return (
    <div>
      <output data-testid="mode">{canEdit ? mode : "read"}</output>
      <output data-testid="error">{transition.error}</output>
      <button onClick={() => void transition.selectMode("read")}>read</button>
      <button onClick={() => void transition.selectMode("edit")}>edit</button>
    </div>
  );
}

async function click(label: string) {
  await act(async () => {
    (Array.from(container.querySelectorAll("button")).find((button) => button.textContent === label) as HTMLButtonElement).click();
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("剧本个人模式切换", () => {
  it("进入只读前先保存；保存失败时保留编辑态和内容", async () => {
    const flush = vi.fn().mockResolvedValue(false);
    act(() => root.render(<Probe canEdit flush={flush} />));
    await click("read");
    expect(flush).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="mode"]')?.textContent).toBe("edit");
    expect(container.querySelector('[data-testid="error"]')?.textContent).toContain("保留编辑模式");
    expect(localStorage.length).toBe(0);
    expect(resetInteractions).not.toHaveBeenCalled();
  });

  it("保存成功后记忆只读并保留滚动锚点", async () => {
    const flush = vi.fn().mockResolvedValue(true);
    act(() => root.render(<Probe canEdit flush={flush} />));
    await click("read");
    expect(container.querySelector('[data-testid="mode"]')?.textContent).toBe("read");
    expect(localStorage.getItem("clickin:script-personal-mode:script-a")).toBe("read");
    expect(preserveScrollAnchor).toHaveBeenCalledWith({ id: "b1", top: 120 });
    expect(resetInteractions).toHaveBeenCalledOnce();
    expect(closeMenu).toHaveBeenCalledOnce();
  });

  it("无编辑权限时不能由模式切换获得编辑能力", async () => {
    const flush = vi.fn().mockResolvedValue(true);
    act(() => root.render(<Probe canEdit={false} flush={flush} />));
    await click("edit");
    expect(container.querySelector('[data-testid="mode"]')?.textContent).toBe("read");
    expect(closeMenu).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });
});
