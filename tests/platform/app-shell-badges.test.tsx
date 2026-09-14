// @vitest-environment jsdom
//
// #487 A2：AppShell 徽标簇出 hook。钉三条搬家前后必须不变的行为：初始值来自服务端
// 下发、切项目立即清零再按新项目取数、通知页广播的 notif-read 带 delta 时就地递减不发请求。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useShellBadges } from "@/components/shell/app-shell/use-shell-badges";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = { userId: "u1", name: "测试", avatarUrl: null };
type Counts = { notifications?: number; tasks?: number; reports?: number; cueWarnings?: number };
let responder: (url: string) => Counts;
const fetchMock = vi.fn((url: string) => Promise.resolve({ json: () => Promise.resolve(responder(url)) }));

type Snapshot = ReturnType<typeof useShellBadges>;
let latest: Snapshot;
function Probe({ pathname, session = SESSION }: { pathname: string; session?: typeof SESSION | null }) {
  latest = useShellBadges({ session, pathname, initialUnreadCount: 3, initialPendingTasks: 2, initialUnreadReports: 1 });
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchMock.mockClear();
  responder = () => ({});
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(pathname: string, session: typeof SESSION | null = SESSION) {
  await act(async () => { root.render(<Probe pathname={pathname} session={session} />); });
}
const fetchedUrls = () => fetchMock.mock.calls.map(([u]) => u);

describe("useShellBadges", () => {
  it("初始值来自服务端下发；挂载即按当前项目取一次数", async () => {
    responder = () => ({ notifications: 7, tasks: 4, reports: 2, cueWarnings: 1 });
    await mount("/production/p1/script");
    expect(fetchedUrls()).toEqual(["/api/my/pending-counts?productionId=p1"]);
    expect(latest).toEqual({ unreadCount: 7, pendingTasks: 4, unreadReports: 2, cueWarnings: 1 });
  });

  it("无 session 不取数，保持初始值", async () => {
    await mount("/", null);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(latest).toEqual({ unreadCount: 3, pendingTasks: 2, unreadReports: 1, cueWarnings: 0 });
  });

  it("响应里缺的字段不覆盖现值", async () => {
    responder = () => ({ tasks: 9 });
    await mount("/");
    expect(fetchedUrls()).toEqual(["/api/my/pending-counts"]);
    expect(latest).toEqual({ unreadCount: 3, pendingTasks: 9, unreadReports: 1, cueWarnings: 0 });
  });

  it("切项目：先清零再按新项目取数，旧项目的数不闪现", async () => {
    responder = (url) => url.includes("p1") ? { notifications: 5, cueWarnings: 2 } : { notifications: 1 };
    await mount("/production/p1");
    expect(latest.unreadCount).toBe(5);
    // 拦住响应，观察清零那一帧
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    fetchMock.mockImplementationOnce((url: string) => gate.then(() => ({ json: () => Promise.resolve(responder(url)) })));
    await act(async () => { root.render(<Probe pathname="/production/p2" />); });
    expect(latest).toEqual({ unreadCount: 0, pendingTasks: 0, unreadReports: 0, cueWarnings: 0 });
    expect(fetchedUrls().at(-1)).toBe("/api/my/pending-counts?productionId=p2");
    await act(async () => { release(); await gate; });
    expect(latest.unreadCount).toBe(1);
  });

  it("同一项目内换页不重复取数", async () => {
    await mount("/production/p1/script");
    await act(async () => { root.render(<Probe pathname="/production/p1/cues" />); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("notif-read 带 delta：就地递减、不低于 0、不发请求；不带 delta 才重新取数", async () => {
    responder = () => ({ notifications: 2 });
    await mount("/");
    expect(latest.unreadCount).toBe(2);
    act(() => { window.dispatchEvent(new CustomEvent("notif-read", { detail: { delta: 1 } })); });
    expect(latest.unreadCount).toBe(1);
    act(() => { window.dispatchEvent(new CustomEvent("notif-read", { detail: { delta: 5 } })); });
    expect(latest.unreadCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    responder = () => ({ notifications: 8 });
    await act(async () => { window.dispatchEvent(new CustomEvent("notif-read")); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest.unreadCount).toBe(8);
  });
});
