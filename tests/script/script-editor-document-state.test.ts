import { describe, expect, it } from "vitest";
import { ScriptDocument } from "@/components/script/script-editor/script-document";
import { makeBlock } from "@/lib/script/script-block-stream";
import { DEFAULT_SCRIPT_CONFIG, type Block, type ScriptState } from "@/lib/script/script-types";
import type { ScriptWindowBootstrap } from "@/lib/script/script-window-types";

const block = (id: string, content = id): Block => ({ ...makeBlock(), id, content });
function bootstrap(blocks: Block[], start = 0, limit = blocks.length): ScriptWindowBootstrap {
  return {
    versionId: "head", orderRevision: "r1", manifest: blocks.map(row => ({ ...row })),
    window: { start, blocks: blocks.slice(start, start + limit), tags: [] },
    scenes: [], characters: [], config: DEFAULT_SCRIPT_CONFIG, tagGroups: [], pageMap: {},
  };
}
const contents = (document: ScriptDocument) => document.getSnapshot().blocks.map(row => row.content);

describe("编辑器正文与保存依据的共同维护", () => {
  it("保存确认后仍保留在途期间的新输入", () => {
    const document = new ScriptDocument(bootstrap([block("a")]));
    document.editBlocks(rows => rows.map(row => ({ ...row, content: "first" })));
    const sent = document.prepareSave(1)!;
    document.editBlocks(rows => rows.map(row => ({ ...row, content: "second" })));
    document.acknowledge(sent);
    expect(contents(document)).toEqual(["second"]);
    expect(document.prepareSave(2)!.patch.blockOps).toEqual([expect.objectContaining({ op: "update", block: expect.objectContaining({ content: "second" }) })]);
    expect(document.prepareSave(2)!.basis).not.toEqual(sent.basis);
  });

  it("未修改窗口在保存期间补齐，不因保存确认退回空骨架", () => {
    const rows = [block("a"), block("b", "server body")];
    const document = new ScriptDocument(bootstrap(rows, 0, 1));
    document.editBlocks(previous => previous.map(row => row.id === "a" ? { ...row, content: "edited" } : row));
    const sent = document.prepareSave(1)!;
    expect(document.mergeWindow({ versionId: "head", orderRevision: "r1", totalCount: 2, window: { start: 1, blocks: [rows[1]], tags: [] } })).toBe(true);
    document.acknowledge(sent);
    expect(contents(document)).toEqual(["edited", "server body"]);
    expect(document.hasPending()).toBe(false);
  });

  it("窗口回包保留本地正文及标签，同时补齐其他行", () => {
    const rows = [block("a"), block("b")];
    const document = new ScriptDocument(bootstrap(rows));
    document.editBlocks(previous => previous.map(row => row.id === "a" ? { ...row, content: "local" } : row));
    document.editTag("a", "g", "local", null, false);
    const basis = document.prepareSave(1)!.basis;
    document.mergeWindow({ versionId: "head", orderRevision: "r1", totalCount: 2, window: {
      start: 0, blocks: [block("a", "remote"), block("b", "new remote")],
      tags: [{ blockId: "a", groupId: "g", optionId: "remote", value: null }],
    } });
    expect(contents(document)).toEqual(["local", "new remote"]);
    expect(document.getSnapshot().tags.get("a")![0].optionId).toBe("local");
    expect(document.prepareSave(2)!.basis).toEqual(basis);
  });

  it.each(["insert", "delete", "reorder"] as const)("骨架刷新保留本地 %s 与条件保存的旧结构依据", action => {
    const rows = [block("a"), block("b"), block("c")];
    const document = new ScriptDocument(bootstrap(rows));
    const next = action === "insert" ? [rows[0], block("local"), ...rows.slice(1)]
      : action === "delete" ? rows.filter(row => row.id !== "b") : [rows[2], rows[0], rows[1]];
    document.editStructure({ ...document.read(), blocks: next }, action === "reorder" ? ["c"] : []);
    const before = document.prepareSave(1)!;
    document.applyBootstrap(bootstrap([block("a", "remote"), rows[1], rows[2]]));
    expect(document.getSnapshot().blocks.map(row => row.id)).toEqual(next.map(row => row.id));
    const after = document.prepareSave(2)!;
    expect(after.patch.blockOps.filter(op => op.op !== "update")).toEqual(before.patch.blockOps.filter(op => op.op !== "update"));
    expect(after.basis).toEqual(before.basis);
  });

  it("新行继承标签立即进入同一笔插入，不等待 React 镜像 effect", () => {
    const document = new ScriptDocument(bootstrap([block("a")]));
    document.editTag("a", "g", "o", null, false);
    document.editBlocks(rows => [...rows, block("new")]);
    document.inheritTags("a", "new");
    expect(document.prepareSave(1)!.patch.blockOps).toContainEqual(expect.objectContaining({
      op: "insert", block: expect.objectContaining({ id: "new" }), tags: [{ groupId: "g", optionId: "o", value: null }],
    }));
  });
  it("本地插入与远端新增交错，不把已接收的远端行再次当成本地插入", () => {
    const document = new ScriptDocument(bootstrap([block("a")]));
    document.editBlocks(rows => [...rows, block("local")]);
    document.applyBootstrap(bootstrap([block("a"), block("remote")]));
    expect(document.getSnapshot().blocks.map(row => row.id)).toEqual(["a", "local", "remote"]);
    expect(document.prepareSave(1)!.patch.blockOps).toEqual([expect.objectContaining({ op: "insert", block: expect.objectContaining({ id: "local" }) })]);
  });

  it("在途期间同一块再次移动，旧确认不能清掉新移动记录", () => {
    const rows = [block("a"), block("b"), block("c")];
    const document = new ScriptDocument(bootstrap(rows));
    document.editStructure({ ...document.read(), blocks: [rows[1], rows[0], rows[2]] }, ["a"]);
    const sent = document.prepareSave(1)!;
    document.editStructure({ ...document.read(), blocks: [rows[1], rows[2], rows[0]] }, ["a"]);
    document.acknowledge(sent);
    expect(document.prepareSave(2)!.patch.blockOps).toContainEqual({ op: "reorder", ids: ["b", "c", "a"], movedIds: ["a"] });
  });

  it("旧顺序窗口整批拒绝，不部分写入正文、标签或已加载集合", () => {
    const document = new ScriptDocument(bootstrap([block("a"), block("b")], 0, 1));
    const before = document.getSnapshot();
    expect(document.mergeWindow({ versionId: "head", orderRevision: "old", totalCount: 2,
      window: { start: 1, blocks: [block("b", "stale")], tags: [] } })).toBe(false);
    expect(document.getSnapshot()).toBe(before);
    expect(document.mergeWindow({ versionId: "head", orderRevision: "r1", totalCount: 2,
      window: { start: 0, blocks: [block("a"), block("wrong")], tags: [] } })).toBe(false);
    expect(document.getSnapshot()).toBe(before);
  });

  it("恢复替换同时建立正文、标签、骨架和保存依据，丢弃未提交旧状态", () => {
    const document = new ScriptDocument(bootstrap([block("a")]));
    document.editBlocks(rows => [...rows, block("local")]);
    document.editTag("a", "g", "local", null, false);
    const recovered = bootstrap([block("a", "fresh"), block("b")], 0, 1);
    recovered.orderRevision = "r2";
    document.applyBootstrap(recovered, true);
    expect(contents(document)).toEqual(["fresh", ""]);
    expect(document.getSnapshot().tags.size).toBe(0);
    expect(document.getSnapshot().loadedIds).toEqual(new Set(["a"]));
    expect(document.getSnapshot().orderRevision).toBe("r2");
    expect(document.hasPending()).toBe(false);
  });

  it("角色与段落的本地修改也保留旧依据，刷新不会单独冲掉其中一组", () => {
    const initial = bootstrap([block("a")]);
    initial.characters = [{ id: "char", name: "old", isAggregate: false }];
    initial.scenes = [{ id: "scene", name: "old", number: "1", parentId: null }];
    const document = new ScriptDocument(initial);
    document.editCharacters(rows => rows.map(row => ({ ...row, name: "local" })));
    document.editStructure({ ...document.read(), scenes: initial.scenes.map(row => ({ ...row, name: "local" })) });
    const before = document.prepareSave(1)!;
    document.applyBootstrap({ ...initial, characters: [{ ...initial.characters[0], name: "remote" }], scenes: [{ ...initial.scenes[0], name: "remote" }] });
    expect(document.getSnapshot().characters[0].name).toBe("local");
    expect(document.getSnapshot().scenes[0].name).toBe("local");
    expect(document.prepareSave(2)!.basis).toEqual(before.basis);
  });

  it("未加载骨架不上传空正文；完整顺序仍用于本地重排", () => {
    const document = new ScriptDocument(bootstrap([block("a"), block("b"), block("c")], 0, 1));
    const rows = document.getSnapshot().blocks;
    document.editStructure({ ...document.read(), blocks: [rows[2], rows[0], rows[1]] }, ["c"]);
    expect(document.prepareSave(1)!.patch.blockOps).toEqual([{ op: "reorder", ids: ["c", "a", "b"], movedIds: ["c"] }]);
  });

  it("远端删除本地脏行仍用旧行作依据，不能悄悄改成插入复活", () => {
    const document = new ScriptDocument(bootstrap([block("a"), block("b")]));
    document.editBlocks(rows => rows.map(row => row.id === "b" ? { ...row, content: "local" } : row));
    const server: ScriptState = { ...document.read(), blocks: [block("a")] };
    document.mergeServer(server);
    expect(document.prepareSave(1)!.patch.blockOps).toContainEqual(expect.objectContaining({ op: "update", block: expect.objectContaining({ id: "b", content: "local" }) }));
    expect(document.prepareSave(1)!.patch.blockOps.some(op => op.op === "insert")).toBe(false);
  });
  it("删除正文由维护者同步清理标签和加载集合，保存仍保留删除的旧依据", () => {
    const initial = bootstrap([block("a"), block("b")]);
    initial.window.tags = [{ blockId: "b", groupId: "g", optionId: "o", value: null }];
    const document = new ScriptDocument(initial);
    document.editBlocks(rows => rows.filter(row => row.id !== "b"));
    expect(document.getSnapshot().tags.has("b")).toBe(false);
    expect(document.getSnapshot().loadedIds.has("b")).toBe(false);
    expect(document.prepareSave(1)!.patch.blockOps).toEqual([{ op: "delete", id: "b" }]);
    expect(document.prepareSave(1)!.basis.blocks.b).toMatchObject({ id: "b", content: "b" });
  });
});
