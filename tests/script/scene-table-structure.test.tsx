// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SceneTableView, { getDefaultViewConfig, type SceneTableViewProps } from "@/components/script/SceneTableView";
import { ALL_SCENE_FIELD_PERMS, NO_SCENE_FIELD_PERMS } from "@/lib/script/scene-field-perms-shared";
import type { MarkerProjection } from "@/lib/script/script-marker-domain";

vi.mock("@/components/assets/MountPointAssets", () => ({ default: () => null }));
vi.mock("@/components/wiki/RelatedWikiChips", () => ({ default: () => null }));
vi.mock("@/hooks/useVisibleEventSource", () => ({ useVisibleEventSource: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const marker = (id: string, kind: "chapter" | "scene", parentId: string | null = null): MarkerProjection => ({
  id, kind, parentId, number: id, name: id,
  synopsis: "", actionLine: "", music: "", stageNotes: "", expectedDuration: "", rehearsalMarks: [],
});
const SCENES = [marker("c0", "chapter"), marker("s1", "scene", "c0"), marker("s2", "scene", "c0"), marker("c1", "chapter"), marker("s3", "scene", "c1"), marker("c2", "chapter")];
let host: HTMLDivElement;
let root: Root;
let props: SceneTableViewProps;
let fetchMock: ReturnType<typeof vi.fn>;
const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(async () => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method ? response(200, { scenes: SCENES }) : response(200, SCENES));
  vi.stubGlobal("fetch", fetchMock);
  props = {
    productionId: "p", scenes: SCENES, versionId: "v", openingChapterMarkerId: "c0", canEdit: true,
    fieldPerms: ALL_SCENE_FIELD_PERMS, viewConfig: getDefaultViewConfig(), onViewConfigChange: vi.fn(),
    onUpdateScene: vi.fn(), onPatchMeta: vi.fn(), onScenesChange: vi.fn(), trackWrite: operation => operation,
  };
  await render();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render() { await act(async () => { root.render(<SceneTableView {...props} />); }); }
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
async function clickText(text: string) {
  const button = buttons().find(item => item.textContent?.trim() === text || item.textContent?.startsWith(text));
  if (!button) throw new Error(`缺少按钮：${text}`);
  await act(async () => button.click());
}
async function openRow(id: string) {
  const button = host.querySelector<HTMLButtonElement>(`[aria-label="${id} ${id} 行操作"]`);
  if (!button) throw new Error(`缺少行操作：${id}`);
  await act(async () => button.click());
}
const writes = (method: string) => fetchMock.mock.calls.filter(([, init]) => init?.method === method);
async function submitName(name: string) {
  const input = host.querySelector<HTMLInputElement>("form input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
function row(id: string) {
  const element = host.querySelector<HTMLTableRowElement>(`[data-scene-id="${id}"]`)!;
  element.getBoundingClientRect = () => ({ top: 100, height: 40, bottom: 140, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON() {} });
  return element;
}
async function fire(target: Element, type: string, clientY = 110) {
  await act(async () => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { clientY, dataTransfer: { setData() {}, effectAllowed: "", dropEffect: "" } });
    target.dispatchEvent(event);
  });
}
async function drag(from: string, to: string, clientY = 110) {
  await fire(row(from).querySelector("[draggable='true']")!, "dragstart");
  await fire(row(to), "dragover", clientY);
  await fire(row(to), "drop", clientY);
}

describe("构作表格结构操作", () => {
  it("新增段落指定父章及插入位置，并采用服务端结果", async () => {
    await openRow("s1"); await clickText("在此段落后新增段落"); await submitName("新段落");
    expect(JSON.parse(writes("POST")[0][1].body)).toEqual({ versionId: "v", name: "新段落", parentId: "c0", insertBeforeSceneId: "s2" });
    expect(props.onScenesChange).toHaveBeenLastCalledWith(SCENES);
  });
  it("章末新增段落落在下一章前，空表仍能创建章节", async () => {
    await openRow("c0"); await clickText("在章末新增段落"); await submitName("章末");
    expect(JSON.parse(writes("POST")[0][1].body)).toMatchObject({ parentId: "c0", insertBeforeSceneId: "c1" });
    props = { ...props, scenes: [] }; await render(); await clickText("＋ 新增章节"); await submitName("首章");
    expect(JSON.parse(writes("POST")[1][1].body)).toMatchObject({ parentId: null, name: "首章" });
  });
  it("创建失败保留输入，显示错误并重新读取服务端状态", async () => {
    await openRow("s1"); await clickText("在此段落后新增段落");
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method ? response(403, { error: "权限不足" }) : response(200, SCENES));
    await submitName("保留的草稿");
    expect(host.querySelector<HTMLInputElement>("form input")?.value).toBe("保留的草稿");
    expect(host.textContent).toContain("权限不足"); expect(props.onScenesChange).toHaveBeenLastCalledWith(SCENES);
  });
  it("202 不自动重复结构写入，不冒充成功", async () => {
    await openRow("s1"); await clickText("在此段落后新增段落");
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method ? response(202, { status: "updating" }) : response(200, SCENES));
    await submitName("仍未完成"); expect(writes("POST")).toHaveLength(1); expect(host.textContent).toContain("操作未完成");
  });
  it("网络异常保留草稿并提示，重新对账的失败也显形", async () => {
    await openRow("s1"); await clickText("在此段落后新增段落");
    fetchMock.mockRejectedValue(new Error("网络已断开"));
    await submitName("网络失败时的草稿");
    expect(host.querySelector<HTMLInputElement>("form input")?.value).toBe("网络失败时的草稿");
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("网络已断开；同步也失败");
    expect(writes("POST")).toHaveLength(1);
  });
  it("逐动作和逐实例权限，字段修改权限不开放结构动作", async () => {
    props = { ...props, fieldPerms: { ...NO_SCENE_FIELD_PERMS, synopsis: true, any: true, deleteIds: ["s1"] } }; await render();
    await openRow("s1");
    const disabledAdd = buttons().find(button => button.textContent?.startsWith("在此段落前"))!;
    expect(disabledAdd.getAttribute("aria-disabled")).toBe("true"); await act(async () => disabledAdd.click()); expect(host.querySelector("form")).toBeNull();
    expect(buttons().find(button => button.textContent === "删除")?.getAttribute("aria-disabled")).toBe("false");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭行操作"]')!.click());
    await openRow("s2"); expect(buttons().find(button => button.textContent?.startsWith("删除"))?.getAttribute("aria-disabled")).toBe("true");
    expect(writes("POST")).toHaveLength(0); expect(writes("DELETE")).toHaveLength(0);
  });
  it("只读模式没有新增、行操作和拖柄", async () => {
    props = { ...props, canEdit: false }; await render();
    expect(host.querySelector("[draggable='true']")).toBeNull(); expect(host.textContent).not.toContain("新增章节"); expect(host.querySelector('[aria-label$="行操作"]')).toBeNull();
  });
  it("删除先确认；取消不发请求，blocked 交共享弹窗", async () => {
    await openRow("s1"); await clickText("删除"); await clickText("取消"); expect(writes("DELETE")).toHaveLength(0);
    await openRow("s1"); await clickText("删除");
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method ? response(409, { plan: { status: "blocked", kind: "scene", message: "该段落包含构作详情，清空详情后才能删除。" } }) : response(200, SCENES));
    await clickText("确认删除"); expect(host.textContent).toContain("不可删除该段落"); expect(writes("DELETE")).toHaveLength(1);
  });
  it("服务端 choice 的保留操作原样传回，不自行判断删除方式", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => !init?.method ? response(200, SCENES) : JSON.parse(String(init.body)).operation ? response(200, { scenes: SCENES }) : response(300, { plan: { status: "choice", options: [{ type: "marker-only", markerId: "c1" }, { type: "whole", markerId: "c1" }], previewBlockIds: ["c1"] } }));
    await openRow("c1"); await clickText("删除"); await clickText("确认删除"); await clickText("保留下属段落");
    expect(JSON.parse(writes("DELETE")[1][1].body)).toMatchObject({ operation: "marker-only" });
  });
  it("拖动同级段落，有明确落点并提交正确位置", async () => {
    await fire(row("s2").querySelector("[draggable='true']")!, "dragstart"); await fire(row("s1"), "dragover");
    expect(row("s1").querySelectorAll("td")[1].style.borderTop).toContain("2px"); await fire(row("s1"), "drop");
    expect(JSON.parse(writes("PUT")[0][1].body)).toMatchObject({ markerId: "s2", beforeMarkerId: "s1" });
  });
  it("松手位置重新判定，不采用上次悬停的边沿", async () => {
    await fire(row("s1").querySelector("[draggable='true']")!, "dragstart");
    await fire(row("s2"), "dragover", 110);
    await fire(row("s2"), "drop", 135);
    expect(JSON.parse(writes("PUT")[0][1].body)).toMatchObject({ markerId: "s1", beforeMarkerId: "c1" });
  });
  it("选择删除方式后服务端拒绝，错误在共享弹窗内显示", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => !init?.method ? response(200, SCENES) : JSON.parse(String(init.body)).operation ? response(403, { error: "删除整段内容需要剧本编辑权限" }) : response(300, { plan: { status: "choice", options: [{ type: "whole", markerId: "c1" }], previewBlockIds: ["c1"] } }));
    await openRow("c1"); await clickText("删除"); await clickText("确认删除"); await clickText("删除全部内容");
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("删除整段内容需要剧本编辑权限");
  });
  it("开场章、跨章和原位落点不写入", async () => {
    expect(row("c0").querySelector("[draggable='true']")).toBeNull();
    await drag("c2", "c0"); await drag("s1", "s3"); await drag("s1", "s2");
    expect(writes("PUT")).toHaveLength(0);
  });
  it("手机/键盘上移下移复用同一排序接口，章末不越界", async () => {
    await openRow("s1"); await clickText("下移"); expect(JSON.parse(writes("PUT")[0][1].body)).toMatchObject({ markerId: "s1", beforeMarkerId: "c1" });
    await openRow("s2"); const down = buttons().find(button => button.textContent?.startsWith("下移"))!;
    expect(down.getAttribute("aria-disabled")).toBe("true");
  });
  it("操作列不会因隐藏编号列而消失，冻结列避开操作列", async () => {
    expect(host.querySelector<HTMLTableCellElement>('tbody tr td:nth-child(2)')?.style.left).toBe("88px");
    props = { ...props, viewConfig: { ...getDefaultViewConfig(), visibleColumns: ["synopsis"] } }; await render();
    expect(host.querySelector('[aria-label="s1 s1 行操作"]')).not.toBeNull();
  });
});
