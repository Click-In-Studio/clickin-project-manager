// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WikiRecentVisits from "@/components/wiki/WikiRecentVisits";

vi.mock("next/link", () => ({ default: ({ href, prefetch: _prefetch, ...props }: { href: string; prefetch?: boolean }) => <a href={href} {...props} /> }));
const id = (n: number) => `a1234567-1234-1234-1234-${String(n).padStart(12, "0")}`;
const item = (n: number) => ({ wikiId: id(n), title: `文档 ${n}`, lastViewedAt: "2026-10-09T00:00:00Z" });
const response = (recent: unknown[], status = 200) => new Response(JSON.stringify({ recent }), { status });
let root: Root;
let container: HTMLDivElement;
const fetchMock = vi.fn();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); fetchMock.mockReset(); });
async function render(currentWikiId?: string, onNavigate = vi.fn()) {
  await act(async () => root.render(<WikiRecentVisits productionId="p1" currentWikiId={currentWikiId} onNavigate={onNavigate} />));
}

describe("云文档最近访问", () => {
  it("真实空数组才显示空状态，接口未接入和损坏响应显示失败", async () => {
    fetchMock.mockResolvedValueOnce(response([])); await render();
    expect(container.textContent).toContain("暂无最近访问记录");
    fetchMock.mockResolvedValueOnce(response([], 404));
    await act(async () => container.querySelector('button[aria-expanded]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => root.unmount()); root = createRoot(container);
    await render(); expect(container.textContent).toContain("最近访问暂不可用");
    expect(container.textContent).not.toContain("暂无最近访问记录");
    fetchMock.mockResolvedValueOnce(new Response('{}'));
    await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === "重试")!.click());
    expect(container.textContent).toContain("最近访问加载失败");
  });
  it("加载未完成不展示空状态", async () => {
    fetchMock.mockReturnValue(new Promise(() => {})); await render();
    expect(container.textContent).toContain("加载中…"); expect(container.textContent).not.toContain("暂无");
  });
  it("去重后最多五条，保留服务端顺序，长标题及当前文档可操作", async () => {
    const longTitle = "超长文档标题".repeat(50);
    fetchMock.mockImplementation((_url, opts) => Promise.resolve(opts?.method === "POST" ? new Response() : response([{ ...item(1), title: longTitle }, item(1), ...[2,3,4,5,6].map(item)])));
    const navigate = vi.fn(); await render(id(1), navigate);
    const links = container.querySelectorAll("a"); expect(links).toHaveLength(5);
    expect(links[0].getAttribute("aria-current")).toBe("page"); expect(links[0].title).toBe(longTitle);
    expect(links[4].getAttribute("href")).toBe(`/production/p1/wiki/${id(5)}`);
    await act(async () => links[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(navigate).toHaveBeenCalledOnce();
    await act(async () => container.querySelector('button[aria-expanded]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });
  it("未打开正文只读列表；访问失败不会虚构当前文档，并在 POST 后重新读取", async () => {
    fetchMock.mockResolvedValueOnce(response([])); await render();
    expect(fetchMock.mock.calls.every(([, opts]) => opts?.method !== "POST")).toBe(true);
    await act(async () => root.unmount()); root = createRoot(container); fetchMock.mockReset();
    fetchMock.mockImplementation((_url, opts) => Promise.resolve(opts?.method === "POST" ? new Response(null, { status: 403 }) : response([item(2)])));
    await render(id(1));
    expect(container.textContent).toContain("本次访问未能记录");
    expect(container.querySelectorAll('a[aria-current]')).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === "POST")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.cache === "no-store").length).toBeGreaterThanOrEqual(2);
  });
  it("离开页面后的旧请求结果不能覆盖新页面", async () => {
    let resolveOld!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { resolveOld = resolve; }));
    await render();
    fetchMock.mockResolvedValueOnce(response([item(2)]));
    await act(async () => root.render(<WikiRecentVisits key="p2" productionId="p2" onNavigate={() => {}} />));
    await act(async () => resolveOld(response([item(1)])));
    expect(container.textContent).toContain("文档 2"); expect(container.textContent).not.toContain("文档 1");
  });
  it("后台打开正文先不记录，首次可见只尝试一次", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fetchMock.mockImplementation((_url, opts) => Promise.resolve(opts?.method === "POST" ? new Response(null, { status: 503 }) : response([item(2)])));
    await render(id(1));
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === "POST")).toHaveLength(0);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === "POST")).toHaveLength(1);
  });
  it("仅可见性恢复及 BFCache 返回都会重新读取其他设备的历史", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fetchMock.mockResolvedValueOnce(response([item(1)])); await render();
    visibility.mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    fetchMock.mockResolvedValueOnce(response([item(2)]));
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(container.textContent).toContain("文档 2");
    fetchMock.mockResolvedValueOnce(response([item(3)]));
    await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(container.textContent).toContain("文档 3");
  });
  it("上传结果未知时不声称漏记，恢复网络、焦点和重试列表均不重传", async () => {
    fetchMock.mockImplementation((_url, opts) => opts?.method === "POST"
      ? Promise.reject(new DOMException("timeout", "TimeoutError")) : Promise.resolve(response([], 503)));
    await render(id(1));
    expect(container.textContent).toContain("本次访问记录未能确认");
    fetchMock.mockImplementation((_url, opts) => Promise.resolve(opts?.method === "POST" ? new Response() : response([item(2)])));
    await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === "重试")!.click());
    await act(async () => {
      window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === "POST")).toHaveLength(1);
    expect(container.textContent).toContain("文档 2");
  });

});
