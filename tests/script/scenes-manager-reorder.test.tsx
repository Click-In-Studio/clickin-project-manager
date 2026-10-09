// @vitest-environment jsdom
//
// #554 拖动排序的两处落点判据，域层拦不住的部分在这里钉住——
//   ① 开场章（编号 0）不接受别人插到它前面：拖柄那侧只藏了开场章自己的把手，
//      它那一行仍然是合法的投放目标，落点线亮起来就会发出一次 PUT；
//   ② 原位放置（拖回自己的上沿或下沿）不发请求：域层对原位返回同一 state，
//      路由据此回 400，前端不吞掉的话用户拖一下没挪窝却弹报错。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import ScenesManager from "@/components/script/ScenesManager";
import { ALL_SCENE_FIELD_PERMS } from "@/lib/script/scene-field-perms-shared";
import type { MarkerProjection } from "@/lib/script/script-marker-domain";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  closed = false;
  constructor(public url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true; }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

function chapter(id: string, number: string, name: string): MarkerProjection {
  return {
    id, number, name, parentId: null, kind: "chapter",
    synopsis: "", actionLine: "", music: "", stageNotes: "", expectedDuration: "",
    rehearsalMarks: [],
  };
}

const SCENES: MarkerProjection[] = [
  chapter("c0", "0", "开场"),
  chapter("c1", "1", "第一章"),
  chapter("c2", "2", "第二章"),
];

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, scenes: SCENES }),
  }));
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ScenesManager
        productionId="p1"
        productionName="演出"
        initialScenes={SCENES}
        openingChapterMarkerId="c0"
        canEdit
        fieldPerms={ALL_SCENE_FIELD_PERMS}
        versionId="v1"
      />,
    );
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

/** 章节行：按行内显示的章名找。 */
function row(name: string): HTMLTableRowElement {
  const found = [...container.querySelectorAll("tr")].find((tr) => tr.textContent?.includes(name));
  if (!found) throw new Error(`没找到「${name}」这一行`);
  // jsdom 的几何全是 0，给出真实的行高，好让上沿 / 下沿判据能分开。
  Object.defineProperty(found, "offsetHeight", { value: 40, configurable: true });
  found.getBoundingClientRect = () => ({ top: 100, bottom: 140, height: 40, width: 0, left: 0, right: 0, x: 0, y: 100, toJSON() {} });
  return found as HTMLTableRowElement;
}

function dataTransfer() {
  return { effectAllowed: "", dropEffect: "", setData() {}, getData: () => "" };
}

function fire(target: Element, type: string, clientY = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientY, dataTransfer: dataTransfer() });
  target.dispatchEvent(event);
  return event;
}

/** 从 `name` 那一行的拖柄开始拖。 */
async function dragFrom(name: string) {
  const handle = row(name).querySelector<HTMLElement>("[draggable='true']");
  if (!handle) throw new Error(`「${name}」这一行没有拖柄`);
  await act(async () => { fire(handle, "dragstart"); });
}

const TOP_EDGE = 110;
const BOTTOM_EDGE = 135;

async function dropOn(name: string, clientY: number) {
  const target = row(name);
  await act(async () => { fire(target, "dragover", clientY); });
  await act(async () => { fire(target, "drop", clientY); });
}

const putCalls = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT");

describe("构作列表拖动排序的落点", () => {
  it("开场章有拖柄就说明这组用例白测了", () => {
    expect(row("开场").querySelector("[draggable='true']")).toBeNull();
    expect(row("第一章").querySelector("[draggable='true']")).not.toBeNull();
  });

  it("拖到开场章上沿：不亮落点线，也不发请求", async () => {
    await dragFrom("第二章");
    await dropOn("开场", TOP_EDGE);
    expect(row("开场").getAttribute("style") ?? "").not.toContain("inset");
    expect(putCalls()).toHaveLength(0);
  });

  it("原位放置：拖回自己的上沿或下沿都不发请求", async () => {
    await dragFrom("第一章");
    await dropOn("第一章", TOP_EDGE);
    expect(putCalls()).toHaveLength(0);

    await dragFrom("第一章");
    await dropOn("第二章", TOP_EDGE);
    expect(putCalls()).toHaveLength(0);
  });

  it("挪到别处照常发一次 PUT", async () => {
    await dragFrom("第二章");
    await dropOn("第一章", TOP_EDGE);
    expect(putCalls()).toHaveLength(1);
    expect(JSON.parse(String(putCalls()[0][1]?.body))).toMatchObject({ markerId: "c2", beforeMarkerId: "c1" });
  });

  it("拖到末章下沿 = 挪到最后，落点是空", async () => {
    await dragFrom("第一章");
    await dropOn("第二章", BOTTOM_EDGE);
    expect(putCalls()).toHaveLength(1);
    expect(JSON.parse(String(putCalls()[0][1]?.body))).toMatchObject({ markerId: "c1", beforeMarkerId: null });
  });

  it("窄屏元数据输入初始约一行、可纵向扩展，失焦仍保存", async () => {
    await act(async () => {
      row("第一章").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const synopsis = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(synopsis).not.toBeNull();
    expect(synopsis?.rows).toBe(2);
    expect(synopsis?.className).toContain("h-10");
    expect(synopsis?.className).toContain("resize-y");
    expect(synopsis?.className).toContain("sm:h-auto");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(synopsis, "新的场次简介");
      synopsis!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "新的场次简介" }));
    });
    await act(async () => {
      synopsis!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    const patchCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall?.[0]).toBe("/api/production/p1/scenes/c1");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({ synopsis: "新的场次简介", versionId: "v1" });
  });
});


describe("无效悬停不复用之前的落点", () => {
  it("同级落点之后放回自身：不写入", async () => {
    await dragFrom("第二章");
    await act(async () => { fire(row("第一章"), "dragover", TOP_EDGE); });
    await dropOn("第二章", TOP_EDGE);
    expect(putCalls()).toHaveLength(0);
  });

  it("drop 必须按实际释放行重新计算，不使用上一行的落点", async () => {
    await dragFrom("第二章");
    await act(async () => { fire(row("第一章"), "dragover", TOP_EDGE); });
    await act(async () => { fire(row("开场"), "drop", TOP_EDGE); });
    expect(putCalls()).toHaveLength(0);
  });

  it("保存失败显示错误并重新读取真实顺序", async () => {
    fetchMock.mockImplementation(async (_url, init) => (init as RequestInit | undefined)?.method === "PUT"
      ? { ok: false, status: 500, json: async () => ({ error: "排序保存失败" }) }
      : { ok: true, status: 200, json: async () => SCENES });
    await dragFrom("第二章");
    await dropOn("第一章", TOP_EDGE);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("排序保存失败");
    expect(fetchMock.mock.calls.some(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(true);
  });
});


async function renderScenes(scenes: MarkerProjection[], canEdit = true, structure = true) {
  await act(async () => {
    root.render(<ScenesManager productionId="p1" productionName="演出" initialScenes={scenes} openingChapterMarkerId="c0" canEdit={canEdit} fieldPerms={{ ...ALL_SCENE_FIELD_PERMS, structure }} versionId="v1" key={`${canEdit}-${structure}-${scenes.length}`} />);
  });
}

async function clickButton(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`没找到按钮 ${label}`);
  await act(async () => { button.click(); });
}

const CHILDREN: MarkerProjection[] = [
  SCENES[0], SCENES[1],
  { ...chapter("s1", "1-1", "段落甲"), kind: "scene", parentId: "c1" },
  { ...chapter("s2", "1-2", "段落乙"), kind: "scene", parentId: "c1" },
  { ...chapter("s3", "1-3", "段落丙"), kind: "scene", parentId: "c1" },
  SCENES[2],
  { ...chapter("s4", "2-1", "段落丁"), kind: "scene", parentId: "c2" },
];

describe("层级、取消与触控排序", () => {
  it("跨章 / 不同层级悬停会清掉旧落点，释放不写入", async () => {
    await renderScenes(CHILDREN);
    for (const target of ["第一章", "段落丁"]) {
      await dragFrom("段落丙");
      await act(async () => { fire(row("段落甲"), "dragover", TOP_EDGE); });
      expect(row("段落甲").style.boxShadow).toContain("inset");
      await dropOn(target, TOP_EDGE);
      expect(row("段落甲").style.boxShadow).toBe("");
      expect(putCalls()).toHaveLength(0);
    }
  });

  it("章末段落下沿使用下一章边界，不改变父章", async () => {
    await renderScenes(CHILDREN);
    await dragFrom("段落甲");
    await dropOn("段落丙", BOTTOM_EDGE);
    expect(JSON.parse(String(putCalls()[0][1]?.body))).toMatchObject({ markerId: "s1", beforeMarkerId: "c2" });
  });

  it("展开详情后在详情区释放不沿用旧落点", async () => {
    await renderScenes(CHILDREN);
    const expand = row("段落乙").querySelector<HTMLButtonElement>('button[title="展开详情"]');
    await act(async () => { expand!.click(); });
    await dragFrom("段落丙");
    await act(async () => { fire(row("段落甲"), "dragover", TOP_EDGE); });
    const details = row("段落乙").nextElementSibling!;
    await act(async () => { fire(details, "dragover", TOP_EDGE); fire(details, "drop", TOP_EDGE); });
    expect(putCalls()).toHaveLength(0);
    expect(row("段落甲").style.boxShadow).toBe("");
  });

  it("取消拖动清掉落点且不写入", async () => {
    await dragFrom("第二章");
    await act(async () => { fire(row("第一章"), "dragover", TOP_EDGE); });
    await act(async () => { fire(row("第二章").querySelector('[draggable="true"]')!, "dragend"); });
    expect(row("第一章").style.boxShadow).toBe("");
    expect(putCalls()).toHaveLength(0);
  });

  it("无需拖拽即可上移，开场章不能被越过", async () => {
    await clickButton("调整顺序：第一章");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="上移：第一章"]')!.disabled).toBe(true);
    await clickButton("调整顺序：第二章");
    await clickButton("上移：第二章");
    expect(JSON.parse(String(putCalls()[0][1]?.body))).toMatchObject({ markerId: "c2", beforeMarkerId: "c1" });
  });

  it("触控下移到章末仍使用下一章边界；末段按钮禁用", async () => {
    await renderScenes(CHILDREN);
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ scenes: CHILDREN }) }));
    await clickButton("调整顺序：段落乙");
    await clickButton("下移：段落乙");
    expect(JSON.parse(String(putCalls()[0][1]?.body))).toMatchObject({ markerId: "s2", beforeMarkerId: "c2" });
    await clickButton("调整顺序：段落丙");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="下移：段落丙"]')!.disabled).toBe(true);
  });

  it("只读模式或无结构权限不显示排序入口", async () => {
    await renderScenes(SCENES, false);
    expect(container.querySelector('[draggable="true"]')).toBeNull();
    await renderScenes(SCENES, true, false);
    expect(container.querySelector('[draggable="true"]')).toBeNull();
  });

  it("直接采用服务端响应顺序，连续点击保存期间只发一次请求", async () => {
    let resolvePut!: (value: unknown) => void;
    fetchMock.mockImplementation((_url, init) => (init as RequestInit | undefined)?.method === "PUT"
      ? new Promise((resolve) => { resolvePut = resolve; })
      : Promise.resolve({ ok: true, status: 200, json: async () => SCENES }));
    await clickButton("调整顺序：第二章");
    await clickButton("上移：第二章");
    await clickButton("上移：第二章");
    expect(putCalls()).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("正在保存");
    await act(async () => { resolvePut({ ok: true, status: 200, json: async () => ({ scenes: [SCENES[0], SCENES[2], SCENES[1]] }) }); });
    const names = [...container.querySelectorAll('tr[data-scene-sort-row]')].map(tr => tr.textContent);
    expect(names[1]).toContain("第二章");
    expect(names[2]).toContain("第一章");
  });

  it("写入和重读都失败时提示并暂停排序，重读成功才恢复", async () => {
    fetchMock.mockImplementation(async () => { throw new Error("网络中断"); });
    await clickButton("调整顺序：第二章");
    await clickButton("上移：第二章");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("无法读取当前顺序");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="调整顺序：第二章"]')!.disabled).toBe(true);
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => SCENES }));
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === "重试读取顺序")!.click(); });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="调整顺序：第二章"]')!.disabled).toBe(false);
  });
});
