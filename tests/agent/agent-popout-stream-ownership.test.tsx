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
  send(status: string | null) {
    this.onmessage?.({ data: JSON.stringify({ subagents: [], parentRunId: "run-current", parentStatus: status }) });
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function watch() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel }));
  return {
    response, cancel,
    send(...lines: unknown[]) { controller.enqueue(new TextEncoder().encode(lines.map(line => `data: ${JSON.stringify(line)}\n\n`).join(""))); },
    close() { controller.close(); },
  };
}
const KEY = "clickin:chat:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
const OTHER = "clickin:chat:11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333";
const json = (data: unknown) => Response.json(data);
const events = [
  { type: "delta", text: "本轮过程正文" },
  { type: "tool", name: "clickin__production-wiki_read", id: "same-tool" },
  { type: "approval", approval: { id: "same-approval", title: "本轮确认卡", description: "确认执行", severity: "warning", allowedDecisions: ["allow-once", "deny"] } },
];

describe("Agent 接流所有权", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mounted: boolean;
  let post: ReturnType<typeof deferred<Response>>;
  let gets: Array<ReturnType<typeof watch>>;
  let getResponse: ((stream: ReturnType<typeof watch>, index: number) => Promise<Response>) | undefined;
  let historyMessages: unknown[];
  let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
  let originalScrollTo: typeof HTMLElement.prototype.scrollTo;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("EventSource", StatusStream);
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    originalScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = vi.fn();
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), clear: () => stored.clear() });
    localStorage.setItem("clickin-ai-last-session:personal", KEY);
    post = deferred<Response>();
    gets = [];
    getResponse = undefined;
    historyMessages = [{ role: "assistant", content: "上一轮回复" }];
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/agent/sessions") return json({ sessions: [
        { key: KEY, title: "当前对话", status: "running" },
        { key: OTHER, title: "另一段对话", status: "done" },
      ] });
      if (url.startsWith("/api/agent/chat/history?")) return json({ messages: historyMessages });
      if (url.startsWith("/api/agent/questions?")) return json({ questions: [] });
      if (url.startsWith("/api/agent/attachments?")) return json({ attachments: [] });
      if (url === "/api/agent/chat/stream" && init?.method === "POST") return post.promise;
      if (url.startsWith("/api/agent/chat/stream?")) {
        const stream = watch();
        gets.push(stream);
        return getResponse ? getResponse(stream, gets.length - 1) : stream.response;
      }
      throw new Error(`测试未准备请求：${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mounted = true;
  });
  afterEach(async () => {
    if (mounted) await act(async () => root.unmount());
    container.remove();
    HTMLElement.prototype.scrollTo = originalScrollTo;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  async function openIdle() {
    // 先恢复一个空闲会话；后续刷新列表才报告 running。
    fetchMock.mockImplementationOnce(async () => json({ sessions: [
      { key: KEY, title: "当前对话", status: "done" },
      { key: OTHER, title: "另一段对话", status: "done" },
    ] }));
    await act(async () => root.render(<AgentPopout open onClose={() => {}} productionId={null} productionName={null} currentWikiId={null} currentAssetId={null} />));
  }
  async function send() {
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "继续");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.click());
  }
  async function select(title: string) {
    await act(async () => Array.from(container.querySelectorAll("button")).find(item => item.textContent?.includes("当前对话") || item.textContent?.includes("另一段对话"))!.click());
    await act(async () => Array.from(container.querySelectorAll("span")).filter(item => item.textContent === title).at(-1)!.click());
  }
  const historyCalls = () => fetchMock.mock.calls.filter(([url]) => url.startsWith("/api/agent/chat/history?"));
  const count = (text: string) => (container.textContent ?? "").split(text).length - 1;

  it.each([true, false])("POST 与 running 通知交错时只接一条流，通知先到=%s", async (notifyFirst) => {
    await openIdle();
    await send();
    const stream = watch();
    if (notifyFirst) await act(async () => StatusStream.current.send("running"));
    await act(async () => post.resolve(stream.response));
    if (!notifyFirst) await act(async () => StatusStream.current.send("running"));
    expect(gets).toHaveLength(0);
    expect(historyCalls()).toHaveLength(1);
    await act(async () => stream.send(...events));
    expect(count("本轮过程正文")).toBe(1);
    expect(count("阅读文档")).toBe(1);
    expect(count("本轮确认卡")).toBe(1);
    // 结束后的历史替换仍需执行，但不能再靠它清理运行中的重复显示。
    historyMessages = [{ role: "assistant", content: "本轮完整回复" }];
    await act(async () => { StatusStream.current.send(null); stream.send({ type: "final", text: "本轮完整回复" }); stream.close(); });
    expect(historyCalls()).toHaveLength(2);
    expect(count("本轮完整回复")).toBe(1);
  });

  it("已在接流时重选当前会话不重新加载或开启第二条流", async () => {
    await openIdle();
    await send();
    const stream = watch();
    await act(async () => post.resolve(stream.response));
    // 刷新列表，让菜单中的同一会话状态为 running。
    await act(async () => root.render(<AgentPopout open={false} onClose={() => {}} productionId={null} productionName={null} currentWikiId={null} currentAssetId={null} />));
    await act(async () => root.render(<AgentPopout open onClose={() => {}} productionId={null} productionName={null} currentWikiId={null} currentAssetId={null} />));
    await select("当前对话");
    expect(gets).toHaveLength(0);
    expect(historyCalls()).toHaveLength(1);
    await act(async () => stream.send(...events));
    expect(count("本轮确认卡")).toBe(1);
  });

  it("切换出去再回来时，旧 POST 延迟返回不得接入新流或清掉忙碌状态", async () => {
    await openIdle();
    await send();
    const postSignal = fetchMock.mock.calls.find(([url]) => url === "/api/agent/chat/stream")![1]!.signal as AbortSignal;
    await act(async () => root.render(<AgentPopout open={false} onClose={() => {}} productionId={null} productionName={null} currentWikiId={null} currentAssetId={null} />));
    await act(async () => root.render(<AgentPopout open onClose={() => {}} productionId={null} productionName={null} currentWikiId={null} currentAssetId={null} />));
    await select("另一段对话");
    expect(postSignal.aborted).toBe(true);
    await select("当前对话");
    expect(gets).toHaveLength(1);
    const stale = watch();
    await act(async () => post.resolve(stale.response));
    expect(stale.cancel).toHaveBeenCalledOnce();
    await act(async () => gets[0].send(...events));
    expect(count("本轮过程正文")).toBe(1);
    expect(container.querySelector('button[aria-label="停止回复"]')).not.toBeNull();
    // 旧消费者收尾后仍不能让后台状态通知再次接流。
    await act(async () => StatusStream.current.send("running"));
    expect(gets).toHaveLength(1);
  });

  it("旧 GET 响应晚到时关闭它的正文，不影响切回后的新消费者", async () => {
    await openIdle();
    const delayed = deferred<Response>();
    getResponse = (stream, index) => index === 0 ? delayed.promise : Promise.resolve(stream.response);
    await act(async () => StatusStream.current.send("running"));
    expect(gets).toHaveLength(1);
    await select("另一段对话");
    await act(async () => root.render(<AgentPopout open={false} onClose={() => {}} productionId={null} productionName={null} currentWikiId={null} currentAssetId={null} />));
    await act(async () => root.render(<AgentPopout open onClose={() => {}} productionId={null} productionName={null} currentWikiId={null} currentAssetId={null} />));
    await select("当前对话");
    expect(gets).toHaveLength(2);
    await act(async () => delayed.resolve(gets[0].response));
    expect(gets[0].cancel).toHaveBeenCalledOnce();
    await act(async () => gets[1].send(...events));
    expect(count("本轮过程正文")).toBe(1);
    expect(container.querySelector('button[aria-label="停止回复"]')).not.toBeNull();
    await select("另一段对话");
    expect(gets[1].cancel).toHaveBeenCalledOnce();
    expect(container.querySelector('button[aria-label="停止回复"]')).toBeNull();
  });

  it("接流请求尚未返回时插话仍走 steer，不启动第二轮", async () => {
    await openIdle();
    await send();
    fetchMock.mockImplementationOnce(async () => json({ ok: true }));
    await send();
    const requests = fetchMock.mock.calls.filter(([url]) => url === "/api/agent/chat/stream");
    expect(JSON.parse(requests[0][1]!.body as string).steer).toBeUndefined();
    expect(JSON.parse(requests[1][1]!.body as string).steer).toBe(true);
    const stream = watch();
    await act(async () => post.resolve(stream.response));
    await act(async () => stream.send(...events));
    expect(gets).toHaveLength(0);
    expect(count("本轮确认卡")).toBe(1);
  });

  it("HTTP 失败后清掉接流状态，并保留服务端错误提示", async () => {
    await openIdle();
    await send();
    await act(async () => post.resolve(new Response(JSON.stringify({ error: "会话暂不可用" }), { status: 503 })));
    expect(container.textContent).toContain("会话暂不可用");
    expect(container.querySelector('button[aria-label="停止回复"]')).toBeNull();
    await act(async () => StatusStream.current.send("running"));
    expect(gets).toHaveLength(1);
  });

  it("旧历史请求晚到不得覆盖新 run，且不能继续开启观看流", async () => {
    await openIdle();
    const history = deferred<Response>();
    fetchMock.mockImplementationOnce(() => history.promise);
    await act(async () => StatusStream.current.send("running"));
    await send();
    const stream = watch();
    await act(async () => post.resolve(stream.response));
    await act(async () => stream.send({ type: "delta", text: "新 run 正文" }));
    await act(async () => history.resolve(json({ messages: [{ role: "assistant", content: "过期历史" }] })));
    expect(count("新 run 正文")).toBe(1);
    expect(count("过期历史")).toBe(0);
    expect(gets).toHaveLength(0);
  });

  it("发送网络失败后释放占用，后台通知仍可恢复接流", async () => {
    await openIdle();
    await send();
    await act(async () => post.reject(new Error("网络中断")));
    expect(container.textContent).toContain("网络中断");
    expect(container.querySelector('button[aria-label="停止回复"]')).toBeNull();
    await act(async () => StatusStream.current.send("running"));
    expect(gets).toHaveLength(1);
  });

  it("卸载时取消观看连接，不请求中止服务端 run", async () => {
    await openIdle();
    await send();
    const stream = watch();
    await act(async () => post.resolve(stream.response));
    await act(async () => root.unmount());
    mounted = false;
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/abort"))).toBe(false);
  });
});
