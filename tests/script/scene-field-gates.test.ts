import { describe, expect, it } from "vitest";
import { requiredPermissions, type ScriptPatch } from "@/lib/script-ops";
import { DEFAULT_SCRIPT_CONFIG, type Block, type Scene, type ScriptState } from "@/lib/script-types";
import {
  SCENE_FIELD_SUBS,
  touchedSceneFields,
} from "@/lib/scene-field-perms";
import { PAGE_PERMISSION_SCOPES } from "@/lib/page-permission-scopes";

// scene 字段门（2026-08-17）：模板发字段级键、判定端就要查字段级键。
// 两条写入路径——构作页 REST（SCENE_FIELD_SUBS）与剧本页 patch
// （requiredPermissions）——同一个字段必须要求同一把钥匙。

function block(over: Partial<Block> & Pick<Block, "id" | "type">): Block {
  return {
    content: "",
    characterIds: [],
    characterAnnotations: {},
    lyric: false,
    sceneId: null,
    rehearsalMark: null,
    ...over,
  };
}

function state(blocks: Block[], scenes: Scene[] = []): ScriptState {
  return { blocks, characters: [], scenes, config: DEFAULT_SCRIPT_CONFIG };
}

function patch(over: Partial<ScriptPatch>): ScriptPatch {
  return { clientSeq: 1, blockOps: [], charOps: [], sceneOps: [], ...over };
}

describe("构作页 REST：字段 → 门", () => {
  it("只对 body 里真正出现的字段判权限", () => {
    expect(touchedSceneFields({ name: "第一场" })).toEqual(["name"]);
    expect(touchedSceneFields({ synopsis: "梗概", music: "主题曲" }).sort())
      .toEqual(["music", "synopsis"]);
    expect(touchedSceneFields({ versionId: "v1" })).toEqual([]);
  });

  it("kind 转换算 meta/type，不是改名", () => {
    expect(touchedSceneFields({ kind: "chapter" })).toEqual(["kind"]);
    expect(SCENE_FIELD_SUBS.kind).toBe("meta/type");
    expect(SCENE_FIELD_SUBS.name).toBe("meta/name");
  });

  it("非字符串字段不触发判权限（类型不合就压根不写）", () => {
    expect(touchedSceneFields({ name: 42, synopsis: null })).toEqual([]);
  });

  it("每个字段门都在构作页激活面里有对应键", () => {
    for (const sub of Object.values(SCENE_FIELD_SUBS)) {
      expect(PAGE_PERMISSION_SCOPES.dramaturgy.has(`node:scene/*/${sub}@edit`)).toBe(true);
    }
  });
});

describe("剧本页 patch：marker 操作 → 门", () => {
  const chapter = block({ id: "m1", type: "chapter_marker", content: "第一章" });

  it("改 marker 标题 = 改场次名（与 REST 同一把钥匙）", () => {
    const next = { ...chapter, content: "序章" };
    const needed = requiredPermissions(
      patch({ blockOps: [{ op: "update", block: next }] }),
      state([chapter]),
    );
    expect([...needed]).toEqual(["node:scene/*/meta/name@edit"]);
  });

  it("改 markerMeta 字段只要该字段的钥匙", () => {
    const next = { ...chapter, markerMeta: { synopsis: "新梗概" } };
    const needed = requiredPermissions(
      patch({ blockOps: [{ op: "update", block: next }] }),
      state([chapter]),
    );
    expect([...needed]).toEqual(["node:scene/*/synopsis@edit"]);
  });

  it("章节 ↔ 场次转换 = meta/type", () => {
    const next = { ...chapter, type: "scene_marker" as const };
    const needed = requiredPermissions(
      patch({ blockOps: [{ op: "update", block: next }] }),
      state([chapter]),
    );
    expect([...needed]).toEqual(["node:scene/*/meta/type@edit"]);
  });

  it("插入 / 删除 marker = scene 的 create / delete，不是 edit", () => {
    const inserted = requiredPermissions(
      patch({ blockOps: [{ op: "insert", block: chapter, afterId: null }] }),
      state([]),
    );
    expect([...inserted]).toEqual(["node:scene/*@create"]);

    const deleted = requiredPermissions(
      patch({ blockOps: [{ op: "delete", id: "m1" }] }),
      state([chapter]),
    );
    expect([...deleted]).toEqual(["node:scene/*@delete"]);
  });

  it("marker 重排 = 结构面 scene/*@edit", () => {
    const other = block({ id: "m2", type: "scene_marker", content: "第二场" });
    const needed = requiredPermissions(
      patch({ blockOps: [{ op: "reorder", ids: ["m2", "m1"] }] }),
      state([chapter, other]),
    );
    expect([...needed]).toEqual(["node:scene/*@edit"]);
  });

  it("角色操作要角色权限，不是 scene 权限", () => {
    const needed = requiredPermissions(
      patch({ charOps: [{ op: "delete", id: "c1" }] }),
      state([]),
    );
    expect([...needed]).toEqual(["node:character/*@edit"]);
  });

  it("正文块改动仍走 blocks@edit，不牵连 scene", () => {
    const line = block({ id: "b1", type: "dialogue", content: "台词" });
    const needed = requiredPermissions(
      patch({ blockOps: [{ op: "update", block: { ...line, content: "改过的台词" } }] }),
      state([line]),
    );
    expect([...needed]).toEqual(["node:script/*/blocks@edit"]);
  });
});

describe("scene 明细行：改名与结构分开", () => {
  const scene: Scene = { id: "s1", number: "1", name: "第一场", parentId: null };

  it("改名只要 meta/name，不要结构钥匙", () => {
    const needed = requiredPermissions(
      patch({ sceneOps: [{ op: "upsert", scene: { ...scene, name: "开场" } }] }),
      state([], [scene]),
    );
    expect([...needed]).toEqual(["node:scene/*/meta/name@edit"]);
  });

  it("换号 / 改归属才是结构面", () => {
    const needed = requiredPermissions(
      patch({ sceneOps: [{ op: "upsert", scene: { ...scene, number: "2" } }] }),
      state([], [scene]),
    );
    expect([...needed]).toEqual(["node:scene/*@edit"]);
  });

  it("新建 scene 明细 = create", () => {
    const needed = requiredPermissions(
      patch({ sceneOps: [{ op: "upsert", scene }] }),
      state([], []),
    );
    expect([...needed]).toEqual(["node:scene/*@create"]);
  });
});
