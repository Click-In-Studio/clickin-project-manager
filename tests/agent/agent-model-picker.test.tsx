// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AgentModelPicker from "@/components/agent/AgentModelPicker";
import type { AgentModelInfo, ModelSelection } from "@/lib/agent/model-types";
const models: AgentModelInfo[] = [
  {
    key: "deepseek-flash",
    name: "澄思·轻量",
    description: "基线",
    costTier: "low",
    input: ["text", "image"],
    thinkingLevels: ["off", "low", "high"],
    available: true,
    unavailableReason: null,
  },
  {
    key: "resonance",
    name: "共鸣",
    description: "音视频",
    costTier: "low",
    input: ["text", "audio", "video"],
    thinkingLevels: ["off", "low", "medium", "high"],
    available: true,
    unavailableReason: null,
  },
  {
    key: "inspiration",
    name: "灵光",
    description: "PDF",
    costTier: "medium",
    input: ["text", "file"],
    thinkingLevels: ["low", "medium", "high"],
    available: false,
    unavailableReason: "个人创作者档可使用此模型",
  },
];
const initial: ModelSelection = {
  modelKey: "deepseek-flash",
  thinkingLevel: "low",
  disabledSubagentModels: [],
};
let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});
async function render(props: Parameters<typeof AgentModelPicker>[0]) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<AgentModelPicker {...props} />));
}
async function click(element: Element | null) {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
}
describe("模型选择器", () => {
  it("展示档位限制原因，保存思考强度和子任务禁用；运行中提示下一轮生效", async () => {
    const writes: ModelSelection[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          writes.push(JSON.parse(String(init.body)).modelSelection);
          return Response.json({ ok: true });
        }
        return Response.json({ models, selection: initial });
      }),
    );
    await render({
      sessionKey: "existing",
      productionId: null,
      running: true,
      ensureSession: async () => "existing",
    });
    expect(host.textContent).not.toContain("下轮生效");
    expect(host.querySelector('[aria-label="会话模型"] button')?.textContent).toContain("澄思·轻量");
    expect(host.textContent).not.toContain("低成本");
    await click(host.querySelector('[aria-label="会话模型"] button'));
    expect(document.body.textContent).toContain("个人创作者档可使用此模型");
    expect(document.body.textContent).toContain("低成本");
    expect(document.body.textContent).toContain("中成本");
    const restricted = [...document.body.querySelectorAll("button")].find(
      (item) => item.textContent?.startsWith("灵光"),
    );
    expect(restricted?.disabled).toBe(true);
    const resonance = [...document.body.querySelectorAll("button")].find(
      (item) => item.textContent?.startsWith("共鸣"),
    );
    await click(resonance ?? null);
    expect(writes[0]).toEqual({ ...initial, modelKey: "resonance" });
    expect(host.textContent).toContain("下轮生效");
    expect(host.querySelector('[aria-label="会话模型"] button')?.textContent).not.toContain("成本");
    await click(host.querySelector('[aria-label="思考强度"] button'));
    await click(
      [...document.body.querySelectorAll("button")].find((item) =>
        item.textContent?.includes("标准思考"),
      ) ?? null,
    );
    expect(writes.at(-1)?.thinkingLevel).toBe("medium");
    await click(host.querySelector('[aria-label="会话模型"] button'));
    await click(document.body.querySelector("summary"));
    await click(document.body.querySelectorAll('input[type="checkbox"]')[2]);
    expect(writes.at(-1)?.disabledSubagentModels).toEqual(["inspiration"]);
  });
  it("新会话建立导致 prop 更新时，较慢的目录响应不会覆盖刚保存的选择", async () => {
    const saving = vi.fn();
    let saved = initial;
    let finishSave!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          await gate;
          saved = JSON.parse(String(init.body)).modelSelection;
          return Response.json({ ok: true });
        }
        return Response.json({ models, selection: saved });
      }),
    );
    const ensureSession = async () => {
      root.render(
        <AgentModelPicker
          sessionKey="new"
          productionId={null}
          running={false}
          ensureSession={ensureSession}
          onSavingChange={saving}
        />,
      );
      return "new";
    };
    await render({
      sessionKey: null,
      productionId: null,
      running: false,
      ensureSession,
      onSavingChange: saving,
    });
    await click(host.querySelector('[aria-label="会话模型"] button'));
    await click(
      [...document.body.querySelectorAll("button")].find((item) =>
        item.textContent?.startsWith("共鸣"),
      ) ?? null,
    );
    expect(saving).toHaveBeenLastCalledWith(true);
    expect(host.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("正在保存模型设置");
    await act(async () => {
      finishSave();
      await gate;
    });
    expect(
      host.querySelector('[aria-label="会话模型"]')?.textContent,
    ).toContain("共鸣");
    expect(saved.modelKey).toBe("resonance");
    expect(saving.mock.calls).toEqual([[true], [false]]);
  });
});
