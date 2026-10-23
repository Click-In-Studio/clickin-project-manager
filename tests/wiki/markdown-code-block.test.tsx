// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import MarkdownCodeBlock from "@/components/wiki/MarkdownCodeBlock";

const pending = vi.hoisted(() => {
  let complete!: (html: string) => void;
  const result = new Promise<string>(resolve => { complete = resolve; });
  return { complete, highlight: vi.fn(() => result) };
});
vi.mock("shiki", () => ({ codeToHtml: pending.highlight }));

it("实例交接时共享在途高亮；旧实例迟到填入缓存后新实例仍显示当前代码（#1048）", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"), root = createRoot(container);
  document.body.appendChild(container);
  const code = "const handoff = 1;";
  try {
    await act(async () => { root.render(<MarkdownCodeBlock key="old" code={code} lang="typescript" />); });
    await vi.dynamicImportSettled();
    expect(pending.highlight).toHaveBeenCalledTimes(1);
    await act(async () => { root.render(<MarkdownCodeBlock key="new" code={code} lang="typescript" />); });
    await act(async () => { pending.complete(`<pre data-handoff><code>${code}</code></pre>`); });
    expect(container.querySelector("[data-handoff]")?.textContent).toBe(code);
    expect(pending.highlight).toHaveBeenCalledTimes(1);
    await act(async () => { root.render(<MarkdownCodeBlock key="cached" code={code} lang="typescript" />); });
    expect(container.querySelector("[data-handoff]")?.textContent).toBe(code);
    expect(pending.highlight).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
