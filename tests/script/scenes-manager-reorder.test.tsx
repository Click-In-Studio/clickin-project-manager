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
});
