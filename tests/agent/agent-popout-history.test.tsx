// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentPopout from "@/components/agent/AgentPopout";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => router }));
vi.mock("@/components/ui/Markdown", () => ({ default: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock("@/components/agent/AgentModelPicker", () => ({ default: () => null }));
vi.mock("@/components/agent/VoiceRecordButton", () => ({ default: () => null }));

class StatusStream {
  static current: StatusStream;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { StatusStream.current = this; }
  close() {}
  send(runId: string, status: string | null) {
    this.onmessage?.({ data: JSON.stringify({ subagents: [], parentRunId: runId, parentStatus: status }) });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const KEY = "clickin:chat:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
const OTHER_KEY = "clickin:chat:11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333";
const json = (data: unknown) => {
  const page = data as { messages?: Array<Record<string, unknown>> };
  const body = page.messages ? { attachments: [], nextCursor: null, ...page,
    messages: page.messages.map((message, index) => ({ key: `${index + 1}:fixture:${message.role}`, ...message })) } : data;
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
};
const originalHistory = [{ role: "assistant", content: "上一轮回复" }];

describe("Agent 同一会话的后台历史同步", () => {
  let container: HTMLDivElement;
  let root: Root;
  let history: Array<ReturnType<typeof deferred<Response>>>;
  let questionResponse: unknown;
  let chatController: ReadableStreamDefaultController<Uint8Array>;
  let historyRequests: string[];
  let originalScrollTo: typeof HTMLElement.prototype.scrollTo;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("EventSource", StatusStream);
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      clear: () => stored.clear(),
    });
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    originalScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = vi.fn();
    localStorage.clear();
    localStorage.setItem("clickin-ai-last-session:personal", KEY);
    history = [deferred<Response>()];
    historyRequests = [];
    questionResponse = { questions: [] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/agent/sessions") return json({ sessions: [
        { key: KEY, title: "当前对话", status: "done" },
        { key: OTHER_KEY, title: "另一段对话", status: "done" },
      ] });
      if (url.startsWith("/api/agent/chat/history?")) {
        historyRequests.push(url);
        const response = history.shift();
        if (!response) throw new Error("测试未准备历史响应");
        return response.promise;
      }
      if (url.startsWith("/api/agent/questions?")) return json(questionResponse);
      if (url.startsWith("/api/agent/attachments?")) return json({ attachments: [] });
      if (url === "/api/agent/chat/stream") return new Response(new ReadableStream<Uint8Array>({ start(controller) { chatController = controller; } }));
      throw new Error(`测试未准备请求：${url}`);
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    HTMLElement.prototype.scrollTo = originalScrollTo;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function open(messages: unknown[] = originalHistory, nextCursor: string | null = null) {
    const first = history[0];
    await act(async () => root.render(<AgentPopout open onClose={() => {}} productionId={null} productionName={null} currentWikiId={null} currentAssetId={null} />));
    expect(container.textContent).toContain("正在加载对话…");
    await act(async () => first.resolve(json({ messages, nextCursor })));
    expect(container.textContent).not.toContain("正在加载对话…");
  }
  function stream(line: unknown) {
    chatController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(line)}\n\n`));
  }
  function button(text: string) {
    return Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes(text))!;
  }

  it("正常回复结束后同步历史，等待期间保留回复并显示轻量加载提示", async () => {
    await open();
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "继续");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.click());
    await act(async () => {
      stream({ type: "delta", text: "本轮完整回复" });
      StatusStream.current.send("本轮", "running");
    });
    const refreshed = deferred<Response>();
    history.push(refreshed);
    await act(async () => {
      StatusStream.current.send("本轮", null);
      stream({ type: "final", text: "本轮完整回复" });
      chatController.close();
    });
    expect(historyRequests).toHaveLength(2);
    expect(container.textContent).toContain("本轮完整回复");
    expect(container.textContent).toContain("正在加载对话…");
    await act(async () => refreshed.resolve(json({ messages: [...originalHistory, { role: "user", content: "继续" }, { role: "assistant", content: "本轮完整回复" }] })));
    expect(container.textContent).toContain("本轮完整回复");
  });

  it("错过 running 的后台完成仍原位同步，并恢复待答卡", async () => {
    await open();
    const refreshed = deferred<Response>();
    history.push(refreshed);
    questionResponse = { questions: [{ id: "question_background", toolCallId: "tool_background", waitMode: "continue_independent", status: "pending", questions: [{ questionId: "choice", header: "风格", question: "希望哪种风格？", options: [{ label: "写实" }, { label: "舞台化" }] }] }] };
    await act(async () => StatusStream.current.send("快速后台轮次", null));
    expect(container.textContent).toContain("上一轮回复");
    expect(container.textContent).toContain("正在加载对话…");
    await act(async () => refreshed.resolve(json({ messages: [...originalHistory, { role: "assistant", content: "后台研读结果" }] })));
    expect(container.textContent).toContain("后台研读结果");
    expect(container.textContent).toContain("希望哪种风格？");
    await act(async () => StatusStream.current.send("快速后台轮次", null));
    expect(historyRequests).toHaveLength(2);
  });

  it("后台同步保留已展开的工具详情", async () => {
    const messages = [{ role: "tool", name: "clickin__production-wiki_read", id: "tool_read", result: "文档正文" }];
    await open(messages);
    await act(async () => button("阅读文档").click());
    const expanded = button("阅读文档");
    expect(expanded.getAttribute("aria-expanded")).toBe("true");
    const refreshed = deferred<Response>();
    history.push(refreshed);
    await act(async () => StatusStream.current.send("完成轮次", null));
    expect(container.textContent).toContain("文档正文");
    expect(button("阅读文档")).toBe(expanded);
    await act(async () => refreshed.resolve(json({ messages })));
    expect(button("阅读文档")).toBe(expanded);
    expect(expanded.getAttribute("aria-expanded")).toBe("true");
  });

  it("实时工具落成历史后沿用组件，保留展开详情", async () => {
    await open();
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "读取文档");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.click());
    await act(async () => stream({ type: "tool", id: "live-read", name: "clickin__production-wiki_read", input: { wikiId: "test" } }));
    await act(async () => button("阅读文档").click());
    const expanded = button("阅读文档");
    const refreshed = deferred<Response>();
    history.push(refreshed);
    await act(async () => {
      StatusStream.current.send("落库轮次", null);
      stream({ type: "tool-result", id: "live-read", result: "读取完成" });
      stream({ type: "final", text: "读取完成" });
      chatController.close();
    });
    await act(async () => refreshed.resolve(json({ messages: [...originalHistory,
      { role: "user", content: "读取文档" },
      { role: "tool", id: "live-read", name: "clickin__production-wiki_read", result: "读取完成" },
      { role: "assistant", content: "读取完成" },
    ] })));
    expect(button("阅读文档")).toBe(expanded);
    expect(expanded.getAttribute("aria-expanded")).toBe("true");
  });

  it("后台同步响应到达后，问题卡的未提交输入仍留在原组件", async () => {
    questionResponse = { questions: [{ id: "draft_question", toolCallId: "draft_tool", waitMode: "continue_independent", status: "pending",
      createdAtMs: Date.now(), questions: [{ questionId: "choice", header: "风格", question: "希望哪种风格？", isOther: true, options: [{ label: "写实" }] }] }] };
    await open();
    const draft = container.querySelector<HTMLInputElement>('input[placeholder="其他：自由输入…"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(draft, "偏舞台化");
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const refreshed = deferred<Response>();
    history.push(refreshed);
    await act(async () => StatusStream.current.send("同步问题", null));
    await act(async () => refreshed.resolve(json({ messages: originalHistory })));
    expect(container.querySelector('input[placeholder="其他：自由输入…"]')).toBe(draft);
    expect(draft.value).toBe("偏舞台化");
  });

  it("较早已回答的问题只随对应历史页恢复，不堆到最新回复之后", async () => {
    questionResponse = { questions: [{ id: "old_question", toolCallId: "old_tool", waitMode: "required", status: "answered",
      createdAtMs: Date.now(), answer: { choice: ["写实"] },
      questions: [{ questionId: "choice", header: "风格", question: "此前选择的风格", options: [{ label: "写实" }] }] }] };
    await open([{ key: "20:fixture:assistant", role: "assistant", content: "最新回复" }], "20.20");
    expect(container.textContent).not.toContain("此前选择的风格");
    const older = deferred<Response>();
    history.push(older);
    await act(async () => button("加载更早的对话").click());
    expect(container.textContent).toContain("最新回复");
    await act(async () => older.resolve(json({ messages: [
      { key: "10:fixture:tool", role: "tool", id: "old_tool", name: "clickin__ask_user", result: "已回答" },
    ] })));
    expect(container.textContent).toContain("此前选择的风格");
  });

  it("切换到另一段对话仍清空原内容，并显示加载状态", async () => {
    await open();
    const other = deferred<Response>();
    history.push(other);
    await act(async () => button("当前对话").click());
    await act(async () => Array.from(container.querySelectorAll("span")).find((item) => item.textContent === "另一段对话")!.click());
    expect(container.textContent).not.toContain("上一轮回复");
    expect(container.textContent).toContain("正在加载对话…");
    await act(async () => other.resolve(json({ messages: [{ role: "assistant", content: "另一段历史" }] })));
    expect(container.textContent).toContain("另一段历史");
    expect(container.textContent).not.toContain("正在加载对话…");
  });
});
