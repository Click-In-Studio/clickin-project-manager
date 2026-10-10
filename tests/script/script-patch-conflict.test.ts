import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupProduction, makeBlocks, makeProduction, shortId } from "../_support/factories";
import { loadProduction } from "@/lib/script/script-state-db";
import { applyPatchToDB } from "@/lib/script/script-patch-db";
import { buildScriptPatchBasis, ScriptPatchConflict } from "@/lib/script/script-patch-basis";
import { diffState, type ScriptPatch } from "@/lib/script/script-ops";
import type { ScriptState } from "@/lib/script/script-types";
import { createTagGroup, getBlockTagsByIds, upsertBlockTag } from "@/lib/script/script-block-tag-db";
import { getPool } from "@/lib/pg";

let prodId: string;
let versionId: string;
const read = async () => (await loadProduction(prodId, versionId))!.state;
beforeAll(async () => {
  ({ prodId, versionId } = await makeProduction());
  await makeBlocks(prodId, versionId, 5);
});
afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });
function edit(base: ScriptState, index: number, content: string): ScriptPatch {
  const blocks = base.blocks.map((b, i) => i === index ? { ...b, content } : b);
  return diffState(base, { ...base, blocks }, 1);
}
const submit = (base: ScriptState, patch: ScriptPatch) => applyPatchToDB(prodId, versionId, patch, buildScriptPatchBasis(base, patch, new Map()));
const textIndex = (s: ScriptState) => s.blocks.findIndex(b => b.type === "stage" || b.type === "dialogue");

describe("条件保存的真实数据库竞争（#933）", () => {
  it("线上未改：离线编辑可保存；同一请求重发不重复写", async () => {
    const base = await read();
    const index = textIndex(base);
    const patch = edit(base, index, "离线但没有竞争");
    await submit(base, patch);
    await submit(base, patch);
    expect((await read()).blocks[index].content).toBe("离线但没有竞争");
  });
  it("隔天旧编辑不能覆盖导演的新台词，整批回滚", async () => {
    const base = await read();
    const index = textIndex(base);
    await submit(base, edit(base, index, "导演的新台词"));
    const patch = edit(base, index, "昨天没有传上的旧台词");
    patch.charOps.push({ op: "upsert", char: { id: shortId(), name: "不应写入", isAggregate: false } });
    await expect(submit(base, patch)).rejects.toBeInstanceOf(ScriptPatchConflict);
    const now = await read();
    expect(now.blocks[index].content).toBe("导演的新台词");
    expect(now.characters.some(c => c.name === "不应写入")).toBe(false);
  });
  it("两个请求都依据同一旧值：只有一个能提交", async () => {
    const base = await read();
    const index = textIndex(base);
    const results = await Promise.allSettled([
      submit(base, edit(base, index, "竞争甲")), submit(base, edit(base, index, "竞争乙")),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(["竞争甲", "竞争乙"]).toContain((await read()).blocks[index].content);
  });
  it("其他块改动不阻止本块保存", async () => {
    const base = await read();
    const indices = base.blocks.flatMap((b, i) => b.type === "stage" || b.type === "dialogue" ? [i] : []);
    await submit(base, edit(base, indices[0], "只改第一块"));
    await submit(base, edit(base, indices[1], "只改第二块"));
    expect((await read()).blocks[indices[1]].content).toBe("只改第二块");
  });
  it("已提交后响应丢失，导演再改：旧重试仍被拒绝", async () => {
    const base = await read();
    const index = textIndex(base);
    const old = edit(base, index, "已提交的旧编辑");
    await submit(base, old);
    const next = await read();
    await submit(next, edit(next, index, "后来导演的修改"));
    await expect(submit(base, old)).rejects.toBeInstanceOf(ScriptPatchConflict);
    expect((await read()).blocks[index].content).toBe("后来导演的修改");
  });
  it("旧删除不能删除后来改过的块", async () => {
    const base = await read();
    const index = textIndex(base);
    await submit(base, edit(base, index, "删除前被别人改过"));
    const patch: ScriptPatch = { clientSeq: 1, blockOps: [{ op: "delete", id: base.blocks[index].id }], charOps: [], sceneOps: [] };
    await expect(submit(base, patch)).rejects.toBeInstanceOf(ScriptPatchConflict);
    expect((await read()).blocks[index].content).toBe("删除前被别人改过");
  });
  it("旧排序不能覆盖线上新增块", async () => {
    const base = await read();
    const anchor = base.blocks.at(-1)!;
    const inserted = { ...anchor, id: shortId(), content: "线上新增" };
    const insertion: ScriptPatch = { clientSeq: 1, blockOps: [{ op: "insert", block: inserted, afterId: anchor.id }], charOps: [], sceneOps: [] };
    await submit(base, insertion);
    const order: ScriptPatch = { clientSeq: 1, blockOps: [{ op: "reorder", ids: base.blocks.map(b => b.id).reverse() }], charOps: [], sceneOps: [] };
    await expect(submit(base, order)).rejects.toBeInstanceOf(ScriptPatchConflict);
    expect((await read()).blocks.some(b => b.id === inserted.id)).toBe(true);
  });
  it("标签旧依据拒绝线上后来修改，已达到目标的标签重试成功", async () => {
    const base = await read();
    const block = base.blocks[textIndex(base)];
    const group = await createTagGroup(prodId, { name: "竞争标签", type: "range", rangeMin: 0, rangeMax: 10 });
    await upsertBlockTag(block.id, group.id, null, 1);
    const oldTags = new Map([[block.id, [{ groupId: group.id, optionId: null, value: 1 }]]]);
    const patch: ScriptPatch = { clientSeq: 1, blockOps: [{ op: "update", block, tags: [{ groupId: group.id, optionId: null, value: 2 }] }], charOps: [], sceneOps: [] };
    const basis = buildScriptPatchBasis(base, patch, oldTags);
    await upsertBlockTag(block.id, group.id, null, 3);
    await expect(applyPatchToDB(prodId, versionId, patch, basis)).rejects.toBeInstanceOf(ScriptPatchConflict);
    expect((await getBlockTagsByIds(prodId, [block.id])).find(t => t.groupId === group.id)?.value).toBe(3);
    await upsertBlockTag(block.id, group.id, null, 2);
    await applyPatchToDB(prodId, versionId, patch, basis);
    expect((await getBlockTagsByIds(prodId, [block.id])).find(t => t.groupId === group.id)?.value).toBe(2);
  });
  it("角色元数据竞争在真实事务内被拒绝", async () => {
    const base = await read();
    const character = { id: shortId(), name: "初始角色", isAggregate: false };
    await submit(base, { clientSeq: 1, blockOps: [], sceneOps: [], charOps: [{ op: "upsert", char: character }] });
    const old = await read();
    await submit(old, { clientSeq: 1, blockOps: [], sceneOps: [], charOps: [{ op: "upsert", char: { ...character, name: "导演的新名字" } }] });
    const local: ScriptPatch = { clientSeq: 1, blockOps: [], sceneOps: [], charOps: [{ op: "upsert", char: { ...character, name: "旧页面的名字" } }] };
    await expect(submit(old, local)).rejects.toBeInstanceOf(ScriptPatchConflict);
    expect((await read()).characters.find(c => c.id === character.id)?.name).toBe("导演的新名字");
  });
  it("检查与写入在同一锁内：等待中的旧请求看到先提交的新内容", async () => {
    const base = await read();
    const index = textIndex(base);
    const connection = await getPool().connect();
    await connection.query("BEGIN");
    await connection.query("SELECT pg_advisory_xact_lock(hashtext($1))", [versionId]);
    const pending = submit(base, edit(base, index, "等待锁的旧提交"));
    // 经同一连接构造先完成的线上写，随后放行旧提交。
    await connection.query("UPDATE script SET content = $1 WHERE id = (SELECT snapshot_id FROM script_version WHERE version_id = $2 AND block_id = $3)", ["锁内先完成的导演编辑", versionId, base.blocks[index].id]);
    await connection.query("COMMIT");
    connection.release();
    await expect(pending).rejects.toBeInstanceOf(ScriptPatchConflict);
    expect((await read()).blocks[index].content).toBe("锁内先完成的导演编辑");
  });
});
