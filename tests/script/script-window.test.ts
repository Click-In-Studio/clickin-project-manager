import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupProduction, makeBlocks, makeProduction } from "../_support/factories";
import { loadScriptWindow, loadScriptWindowBootstrap } from "@/lib/script/script-window-db";
import { manifestEntryToSkeleton } from "@/lib/script/script-window-types";
import { loadProduction } from "@/lib/script/script-state-db";

let prodId: string;
let versionId: string;
let allBlockIds: string[];

beforeAll(async () => {
  ({ prodId, versionId } = await makeProduction());
  await makeBlocks(prodId, versionId, 6);
  allBlockIds = (await loadProduction(prodId, versionId))!.state.blocks.map((block) => block.id);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("剧本分窗读取（#644）", () => {
  it("bootstrap 下发完整轻量顺序，但正文只给目标窗口", async () => {
    const result = await loadScriptWindowBootstrap(prodId, versionId, 2, 2);
    expect(result).not.toBeNull();
    expect(result!.manifest.map((entry) => entry.id)).toEqual(allBlockIds);
    expect(result!.window.start).toBe(2);
    expect(result!.window.blocks.map((block) => block.id)).toEqual(allBlockIds.slice(2, 4));
    expect(result!.window.blocks.every((block) => block.content.length > 0)).toBe(true);
    expect(result!.orderRevision).toMatch(/^[0-9a-f]{32}$/);
  });

  it("后续窗口带绝对 start，并把越界 start 夹到末尾", async () => {
    const middle = await loadScriptWindow(prodId, versionId, 1, 3);
    expect(middle?.totalCount).toBe(allBlockIds.length);
    expect(middle?.window.start).toBe(1);
    expect(middle?.window.blocks.map((block) => block.id)).toEqual(allBlockIds.slice(1, 4));

    const tail = await loadScriptWindow(prodId, versionId, 999, 3);
    expect(tail?.window.start).toBe(allBlockIds.length - 1);
    expect(tail?.window.blocks.map((block) => block.id)).toEqual([allBlockIds.at(-1)]);
  });

  it("manifest 骨架保留定位字段，不伪造正文与角色挂载", () => {
    const skeleton = manifestEntryToSkeleton({
      id: "b1", type: "dialogue", lyric: false, sceneId: null,
      rehearsalMark: null, ownerMarkerId: "m1",
    });
    expect(skeleton).toMatchObject({
      id: "b1", content: "", characterIds: [], characterAnnotations: {}, ownerMarkerId: "m1",
    });
  });
});
