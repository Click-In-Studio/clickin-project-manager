// @vitest-environment jsdom
//
// #487 C2：CuePage 的 cue 表可见 / 激活 / 本地权限簇出 hook。非平凡的三处：
//   ① 视图偏好 cookie——挂载时恢复（过滤掉已不存在的表 id），之后每次变更写回；
//   ② 激活一张没有编辑权的表——先切过去再问 /access，按回答落到「已放行 / 可自确认 / 需审批」；
//   ③ 激活表不能被切成不可见。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useCueLists } from "@/components/ops/cue-page/use-cue-lists";
import type { CueList } from "@/lib/ops/cue-list-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROD = "p_c2";
const lists = [
  { id: "l1", name: "灯光", createdBy: "u_other" },
  { id: "l2", name: "音响", createdBy: "u_me" },
  { id: "l3", name: "舞台", createdBy: "u_other" },
  { id: "l4", name: "服化", createdBy: "u_other" },
] as unknown as CueList[];

type Snapshot = ReturnType<typeof useCueLists>;
const seen: Snapshot[] = [];
const latest = () => seen[seen.length - 1];
function Probe({ editable, manage }: { editable: string[]; manage: string[] }) {
  seen.push(useCueLists({ productionId: PROD, cueLists: lists, editableListIds: editable, manageListIds: manage, myUserId: "u_me" }));
  return null;
}

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();

function clearCookies() {
  for (const c of document.cookie.split(";")) {
    const k = c.split("=")[0]?.trim();
    if (k) document.cookie = `${k}=; path=/; max-age=0`;
  }
}
function cookie(key: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

beforeEach(() => {
  seen.length = 0;
  clearCookies();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function mount(editable: string[] = ["l1"], manage: string[] = []) {
  act(() => root.render(<Probe editable={editable} manage={manage} />));
}

describe("useCueLists — 初始态", () => {
  it("默认前三张可见；激活取第一张可编辑的；创建者隐含 manage", () => {
    mount(["l3"], []);
    expect([...latest().visibleListIds]).toEqual(["l1", "l2", "l3"]);
    expect(latest().activeListId).toBe("l3");
    expect(latest().canEditActive).toBe(true);
    expect(latest().localManageIds.has("l2")).toBe(true); // createdBy u_me
    expect(latest().canShareActive).toBe(false);
  });

  it("激活表即使被切成不可见也仍在 visibleLists 里；toggle 对激活表无效", () => {
    mount(["l1"]);
    act(() => latest().toggleListVisibility("l1"));
    expect(latest().visibleListIds.has("l1")).toBe(true);
    act(() => latest().toggleListVisibility("l2"));
    expect(latest().visibleListIds.has("l2")).toBe(false);
    expect(latest().visibleLists.map(l => l.id)).toEqual(["l1", "l3"]);
  });
});

describe("useCueLists — 视图偏好 cookie", () => {
  it("挂载时恢复，过滤掉已不存在的表；之后变更写回", () => {
    document.cookie = `cue_view_${PROD}=${encodeURIComponent(JSON.stringify({ visibleIds: ["l4", "gone"], activeId: "l4" }))}; path=/`;
    mount(["l1"]);
    expect([...latest().visibleListIds]).toEqual(["l4"]);
    expect(latest().activeListId).toBe("l4");
    act(() => latest().toggleListVisibility("l2"));
    expect(JSON.parse(cookie(`cue_view_${PROD}`)!)).toEqual({ visibleIds: ["l4", "l2"], activeId: "l4" });
  });

  it("cookie 里的 activeId 不存在时保留默认激活表", () => {
    document.cookie = `cue_view_${PROD}=${encodeURIComponent(JSON.stringify({ visibleIds: [], activeId: "gone" }))}; path=/`;
    mount(["l1"]);
    expect(latest().activeListId).toBe("l1");
    expect([...latest().visibleListIds]).toEqual(["l1", "l2", "l3"]);
  });
});

describe("useCueLists — 激活无编辑权的表", () => {
  it("有权：直接切换，不问 /access", async () => {
    mount(["l1", "l2"]);
    await act(async () => { await latest().handleActivateList("l2"); });
    expect(latest().activeListId).toBe("l2");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(latest().accessModal).toBe(null);
  });

  it("无权但服务端说 canAccess：本地放行（level=manage 也进 manage 集）并关弹窗", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ canAccess: true, level: "manage" }) });
    mount(["l1"]);
    await act(async () => { await latest().handleActivateList("l3"); });
    await flush();
    expect(fetchMock.mock.calls[0][0]).toContain(`/api/production/${PROD}/cuelists/l3/access`);
    expect(latest().activeListId).toBe("l3");
    expect(latest().localEditableIds.has("l3")).toBe(true);
    expect(latest().localManageIds.has("l3")).toBe(true);
    expect(latest().accessModal).toBe(null);
  });

  it("可自确认 → can_self_confirm 弹窗；不可 → needs_approval；请求失败 → 关弹窗但保持激活", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ canAccess: false, canSelfConfirm: true, selfConfirmLevel: "edit" }) });
    mount(["l1"]);
    await act(async () => { await latest().handleActivateList("l3"); });
    expect(latest().accessModal).toEqual({ listId: "l3", listName: "舞台", status: "can_self_confirm", selfConfirmLevel: "edit" });

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ canAccess: false, canSelfConfirm: false }) });
    await act(async () => { await latest().handleActivateList("l4"); });
    expect(latest().accessModal).toEqual({ listId: "l4", listName: "服化", status: "needs_approval" });

    fetchMock.mockRejectedValueOnce(new Error("net"));
    await act(async () => { await latest().handleActivateList("l3"); });
    expect(latest().accessModal).toBe(null);
    expect(latest().activeListId).toBe("l3");
    expect(latest().canEditActive).toBe(false);
  });
});
