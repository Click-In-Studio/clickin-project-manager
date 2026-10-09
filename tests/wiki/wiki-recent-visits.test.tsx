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
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); fetchMock.mockReset(); });
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
});
