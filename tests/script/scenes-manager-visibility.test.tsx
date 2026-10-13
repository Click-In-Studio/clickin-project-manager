// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import ScenesManager from "@/components/script/ScenesManager";
import { ALL_SCENE_FIELD_PERMS } from "@/lib/script/scene-field-perms-shared";
import type { MarkerProjection } from "@/lib/script/script-marker-domain";

vi.mock("@/components/assets/MountPointAssets", () => ({ default: () => null }));
vi.mock("@/components/wiki/RelatedWikiChips", () => ({ default: () => null }));
vi.mock("@/hooks/useVisibleEventSource", () => ({ useVisibleEventSource: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const chapter = (id: string, name: string): MarkerProjection => ({
  id, name, number: id, kind: "chapter", parentId: null,
  synopsis: "", actionLine: "", music: "", stageNotes: "", expectedDuration: "", rehearsalMarks: [],
});
it("隐藏列表首次显示时采用表格同步后的章节，不再沿用首次挂载的数据", async () => {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const initial = [chapter("c0", "开场")];
  const latest = [...initial, chapter("c1", "表格新建的章节")];
  const render = async (active: boolean, scenes: MarkerProjection[]) => act(async () => root.render(
    <ScenesManager productionId="p" productionName="测试" versionId="v" initialScenes={scenes} openingChapterMarkerId="c0" canEdit={false} fieldPerms={ALL_SCENE_FIELD_PERMS} active={active} embedded />,
  ));
  try {
    await render(false, initial);
    await render(false, latest);
    await render(true, latest);
    expect(host.textContent).toContain("表格新建的章节");
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
  }
});

it("切换可见性不把列表已保存的数据重置为旧的页面初值", async () => {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  const initial = [chapter("c0", "开场")];
  const saved = [{ ...initial[0], name: "列表已保存的新名称" }];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ scenes: saved }) }));
  const render = async (active: boolean) => act(async () => root.render(
    <ScenesManager productionId="p" productionName="测试" versionId="v" initialScenes={initial} openingChapterMarkerId="c0" canEdit fieldPerms={ALL_SCENE_FIELD_PERMS} active={active} embedded />,
  ));
  try {
    await render(true);
    const name = host.querySelector<HTMLElement>('[data-scene-editable="true"]')!;
    await act(async () => name.click());
    const input = host.querySelector<HTMLInputElement>('tbody input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "列表已保存的新名称");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.blur());
    expect(host.textContent).toContain("列表已保存的新名称");
    await render(false); await render(true);
    expect(host.textContent).toContain("列表已保存的新名称");
  } finally {
    await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
  }
});

it("列表接收同步结果时保留字段失败草稿和错误说明", async () => {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "简介保存失败" }) }));
  const initial = [{ ...chapter("c0", "开场"), synopsis: "旧简介" }];
  const render = async (scenes: MarkerProjection[]) => act(async () => root.render(
    <ScenesManager productionId="p" productionName="测试" versionId="v" initialScenes={scenes} openingChapterMarkerId="c0" canEdit fieldPerms={ALL_SCENE_FIELD_PERMS} active embedded />,
  ));
  try {
    await render(initial);
    await act(async () => host.querySelector<HTMLTableRowElement>('tbody tr:nth-child(2)')!.click());
    const input = host.querySelector<HTMLTextAreaElement>('textarea')!;
    input.focus();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "保留的失败简介");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.blur());
    expect(host.textContent).toContain("简介保存失败");
    await render([{ ...initial[0], synopsis: "同步返回的另一份简介" }]);
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe("保留的失败简介");
    expect(host.textContent).toContain("简介保存失败");
  } finally {
    await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
  }
});
