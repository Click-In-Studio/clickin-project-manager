// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import AgentPopout from "@/components/agent/AgentPopout";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/agent/SubagentPanel", () => ({ default: () => null }));

const key = "clickin:chat:4c88cf97-78ca-4c83-a30e-c8af1831f17a:ac93167c-455d-4395-b46a-b91e1d2474c0";
const container = document.createElement("div");
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  localStorage.clear();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  vi.unstubAllGlobals();
});

it("重新打开会话，将历史失败原因恢复为可见提示", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  HTMLElement.prototype.scrollTo = vi.fn();
  localStorage.setItem("clickin-ai-last-session:personal", key);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/agent/sessions") return Response.json({ sessions: [{ key, title: "失败的对话", status: "done" }], gatewayStatus: { state: "connected" } });
    if (url.startsWith("/api/agent/chat/history")) return Response.json({ attachments: [], nextCursor: null, messages: [{ key: "1:fixture:user", role: "user", content: "帮我回顾一下" }, { key: "2:fixture:notice", role: "notice", content: "模型服务当前不可用" }] });
    if (url.startsWith("/api/agent/questions")) return Response.json({ questions: [] });
    if (url.startsWith("/api/agent/models")) return Response.json({ models: [], selection: { modelKey: "deepseek-flash", thinkingLevel: "low", disabledSubagentModels: [] } });
    return Response.json({});
  }));
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<AgentPopout open onClose={vi.fn()} productionId={null} productionName={null} currentWikiId={null} currentAssetId={null} />));
  expect(document.body.textContent).toContain("帮我回顾一下");
  expect(document.body.textContent).toContain("模型服务当前不可用");
});
