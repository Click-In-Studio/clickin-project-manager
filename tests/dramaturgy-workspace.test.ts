import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { createWiki, deleteWiki, listWikiLibrary, getDramaturgyTreeConfig } from "@/lib/wiki-db";
import { listDramaturgyWikiSubtree } from "@/lib/dramaturgy-wiki";
import { makeProduction, cleanupProduction } from "./factories";
import { TEST_USER } from "./helpers";
import type { WikiListEntry } from "@/lib/wiki-db";

// 「构作 · 灵感文档」工作区（#352）：子树成员判定与删除时的父级归位。
// 两条都不是 UI 细节——判错就是文档在这个标签页里凭空消失（去「文档」模块才找得回）。

function entry(id: string, parentId: string | null): WikiListEntry {
  return { id, parentId, title: id, tags: [], sortKey: null } as unknown as WikiListEntry;
}

describe("listDramaturgyWikiSubtree", () => {
  it("收后代、去根自身、不收树外文档", () => {
    const out = listDramaturgyWikiSubtree(
      [entry("root", null), entry("a", "root"), entry("b", "a"), entry("outside", null)],
      "root",
    );
    expect(out.map(w => w.id)).toEqual(["a", "b"]);
  });

  it("rootId 为 null（锚点未懒建）时返回空，不抛", () => {
    expect(listDramaturgyWikiSubtree([entry("a", null)], null)).toEqual([]);
  });

  it("父子成环时终止，不死循环", () => {
    const out = listDramaturgyWikiSubtree([entry("x", "y"), entry("y", "x")], "root");
    expect(out).toEqual([]);
  });

  // ③ 的回归证人：wiki 可见性逐篇判定、不继承，「父不可见、子可见」是合法状态。
  // 成员判定必须跑在全量上——传过滤后的列表进来，孙子会因祖先链断掉而丢失。
  it("成员判定跑在全量上时，父不可见的孙文档仍算子树成员", () => {
    const all = [entry("root", null), entry("mid", "root"), entry("leaf", "mid")];
    const visibleIds = new Set(["leaf"]); // mid 不可见

    const wrong = listDramaturgyWikiSubtree(all.filter(w => visibleIds.has(w.id)), "root");
    expect(wrong.map(w => w.id)).toEqual([]); // 先过滤再算＝leaf 消失（修复前的行为）

    const right = listDramaturgyWikiSubtree(all, "root").filter(w => visibleIds.has(w.id));
    expect(right.map(w => w.id)).toEqual(["leaf"]); // 先算成员再过滤＝leaf 保住
  });
});

describe("deleteWiki 的子文档归位", () => {
  let prodId: string;

  beforeAll(async () => { ({ prodId } = await makeProduction()); });
  afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });

  it("子文档上移一层，留在原子树里而不是掉到顶层", async () => {
    const root = await createWiki({ productionId: prodId, title: "根", body: "", parentId: null, createdBy: TEST_USER });
    const mid = await createWiki({ productionId: prodId, title: "中层", body: "", parentId: root.id, createdBy: TEST_USER });
    const leaf = await createWiki({ productionId: prodId, title: "叶", body: "", parentId: mid.id, createdBy: TEST_USER });

    expect(await deleteWiki(mid.id, prodId)).toEqual({ ok: true });

    const all = await listWikiLibrary(prodId);
    const moved = all.find(w => w.id === leaf.id);
    expect(moved?.parentId).toBe(root.id);          // 不是 null
    expect(listDramaturgyWikiSubtree(all, root.id).map(w => w.id)).toEqual([leaf.id]);
  });

  it("删顶层文档时子文档仍落到顶层（原语义不变）", async () => {
    const top = await createWiki({ productionId: prodId, title: "顶", body: "", parentId: null, createdBy: TEST_USER });
    const child = await createWiki({ productionId: prodId, title: "子", body: "", parentId: top.id, createdBy: TEST_USER });

    expect(await deleteWiki(top.id, prodId)).toEqual({ ok: true });

    const all = await listWikiLibrary(prodId);
    expect(all.find(w => w.id === child.id)?.parentId).toBeNull();
  });
});

describe("getDramaturgyTreeConfig", () => {
  let prodId: string;

  beforeAll(async () => { ({ prodId } = await makeProduction()); });
  afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });

  // ⑤ 的回归证人：渲染路径只准读，不准懒建。读一次不得留下 config 行或根文档。
  it("只读——不建 config 行、不建根文档", async () => {
    const cfg = await getDramaturgyTreeConfig(prodId);
    expect(cfg.enabled).toBe(true);
    expect(cfg.rootWikiId).toBeNull();

    const rows = await getPool().query(
      "SELECT 1 FROM production_wiki_config WHERE production_id = $1", [prodId]);
    expect(rows.rowCount).toBe(0);
    expect(await listWikiLibrary(prodId)).toEqual([]);
  });
});
