// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentPopout from "@/components/agent/AgentPopout";
import type { Bubble } from "@/lib/agent/chat/stream-reducer";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => router }));
vi.mock("@/components/ui/Markdown", () => ({ default: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock("@/components/agent/AgentModelPicker", () => ({ default: () => null }));
vi.mock("@/components/agent/VoiceRecordButton", () => ({ default: () => null }));
// 本文件验证分页合并的数据语义；真实虚拟布局与锚点另有浏览器验收。
vi.mock("@/components/agent/ChatViewport", () => ({ default: forwardRef(function Transcript({ items, renderItem, header, footer }: {
  items: (Bubble & { key: string })[]; renderItem: (item: Bubble, index: number) => ReactNode; header: ReactNode; footer: ReactNode;
}, ref) {
  useImperativeHandle(ref, () => ({ follow() {}, reveal() {} }));
  return <div>{header}{items.map((item, index) => <div key={item.key} data-transcript-key={item.key}>{renderItem(item, index)}</div>)}{footer}</div>;
}) }));
class StatusStream {
  static current: StatusStream;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { StatusStream.current = this; }
  close() {}
  done() { this.onmessage?.({ data: JSON.stringify({ subagents: [], parentRunId: "long-run", parentStatus: null }) }); }
}
const KEY = "clickin:chat:10310000-0000-4000-8000-000000000001:10310000-0000-4000-8000-000000000003";
const json = (messages: unknown[], nextCursor: string | null = null) => Response.json({ messages, nextCursor, attachments: [] });
let container: HTMLDivElement, root: Root;
let history: Response[];
let controller: ReadableStreamDefaultController<Uint8Array>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", StatusStream);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const values = new Map([["clickin-ai-last-session:personal", KEY]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  history = [json([{ key: "1:fixture:assistant", role: "assistant", content: "上一轮回复" }])];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/agent/sessions") return Response.json({ sessions: [{ key: KEY, title: "长任务", status: "done" }] });
    if (url.startsWith("/api/agent/chat/history?")) return history.shift()!;
    if (url.startsWith("/api/agent/questions?")) return Response.json({ questions: [] });
    if (url.startsWith("/api/agent/attachments?")) return Response.json({ attachments: [] });
    if (url === "/api/agent/chat/stream") return new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }));
    throw new Error(`未准备的请求 ${url}`);
  }));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("一轮超过最新一页时，刷新不丢本地已显示内容；补齐旧页后也不重复", async () => {
  await act(async () => root.render(<AgentPopout open onClose={() => {}} productionId={null} productionName={null} currentWikiId={null} currentAssetId={null} />));
  const input = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "长任务的原始请求");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.click());
  const tools = Array.from({ length: 40 }, (_, i) => ({ role: "tool", key: `${i + 3}:fixture:tool`, name: `step_${i}`, id: `call_${i}`, result: `结果_${i}` }));
  const transcript = [
    { key: "2:fixture:user", role: "user", content: "长任务的原始请求" }, ...tools,
    { key: "43:fixture:assistant", role: "assistant", content: "长任务完成" },
  ];
  const send = (line: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(line)}\n\n`));
  await act(async () => { for (const tool of tools) { send({ type: "tool", name: tool.name, id: tool.id, input: {} }); send({ type: "tool-result", id: tool.id, result: tool.result }); } });
  const firstTool = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find(el => el.textContent?.includes("step_0"))!;
  await act(async () => firstTool.click());
  history.push(json(transcript.slice(-30), "43.14"));
  await act(async () => { StatusStream.current.done(); send({ type: "final", text: "长任务完成" }); controller.close(); });
  expect(container.textContent).toContain("长任务的原始请求");
  expect(container.textContent).toContain("结果_0");
  expect(container.querySelectorAll('[data-transcript-key]')).toHaveLength(43);
  history.push(json(transcript.slice(0, -30)));
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === "加载更早的对话")!.click());
  expect(container.querySelectorAll('[data-transcript-key]')).toHaveLength(43);
  expect(container.contains(firstTool)).toBe(true);
  expect(firstTool.getAttribute("aria-expanded")).toBe("true");
});

it("接流期间补更早页面，不把同文旧消息误认成本次输入", async () => {
  history[0] = json([{ key: "10:fixture:assistant", role: "assistant", content: "最近的回复" }], "10.10");
  await act(async () => root.render(<AgentPopout open onClose={() => {}} productionId={null} productionName={null} currentWikiId={null} currentAssetId={null} />));
  const input = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "重复输入");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.click());
  const live = [...container.querySelectorAll<HTMLElement>("[data-transcript-key]")].find(el => el.textContent === "重复输入")!;
  history.push(json([{ key: "1:fixture:user", role: "user", content: "重复输入" }]));
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === "加载更早的对话")!.click());
  const copies = [...container.querySelectorAll<HTMLElement>("[data-transcript-key]")].filter(el => el.textContent === "重复输入");
  expect(copies).toHaveLength(2);
  expect(copies.at(-1)).toBe(live);
  expect(copies[0].dataset.transcriptKey).toBe("1:fixture:user");
});
