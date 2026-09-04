import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { POST as wikiPOST } from "@/app/api/production/[id]/wiki/route";
import { createWiki, deleteWiki } from "@/lib/wiki/content";
import { getDramaturgyTreeConfig } from "@/lib/node/anchors";
import { listNodeLibrary, getNodeByWikiId, type NodeEntry } from "@/lib/node/db";
import { listDramaturgySubtree } from "@/lib/node/dramaturgy";
import { makeProduction, cleanupProduction } from "./factories";
import { TEST_USER } from "./helpers";

// 「构作 · 灵感文档」工作区（#352）：子树成员判定与删除时的父级归位。
// 两条都不是 UI 细节——判错就是文档在这个标签页里凭空消失（去「文档」模块才找得回）。

function entry(id: string, parentId: string | null): NodeEntry {
  return {
    id, parentId, kind: "wiki", wikiId: id, displayTitle: id, title: null,
    tags: [], sortKey: null, isAnchor: false, listable: true, isPublic: false,
    assetId: null, linkTargetId: null, targetKind: null, targetWikiId: null, targetTitle: null,
    productionId: "p", createdBy: null, createdAt: "", updatedAt: "",
  } as NodeEntry;
}

describe("listDramaturgySubtree", () => {
  it("收后代、去根自身、不收树外文档", () => {
    const out = listDramaturgySubtree(
      [entry("root", null), entry("a", "root"), entry("b", "a"), entry("outside", null)],
      "root",
    );
    expect(out.map(w => w.id)).toEqual(["a", "b"]);
  });

  it("rootId 为 null（锚点未懒建）时返回空，不抛", () => {
    expect(listDramaturgySubtree([entry("a", null)], null)).toEqual([]);
  });

  it("父子成环时终止，不死循环", () => {
    const out = listDramaturgySubtree([entry("x", "y"), entry("y", "x")], "root");
    expect(out).toEqual([]);
  });

  // ③ 的回归证人：wiki 可见性逐篇判定、不继承，「父不可见、子可见」是合法状态。
  // 成员判定必须跑在全量上——传过滤后的列表进来，孙子会因祖先链断掉而丢失。
  it("成员判定跑在全量上时，父不可见的孙文档仍算子树成员", () => {
    const all = [entry("root", null), entry("mid", "root"), entry("leaf", "mid")];
    const visibleIds = new Set(["leaf"]); // mid 不可见

    const wrong = listDramaturgySubtree(all.filter(w => visibleIds.has(w.id)), "root");
    expect(wrong.map(w => w.id)).toEqual([]); // 先过滤再算＝leaf 消失（修复前的行为）

    const right = listDramaturgySubtree(all, "root").filter(w => visibleIds.has(w.id));
    expect(right.map(w => w.id)).toEqual(["leaf"]); // 先算成员再过滤＝leaf 保住
  });
});

describe("deleteWiki 的子文档归位", () => {
  let prodId: string;

  beforeAll(async () => { ({ prodId } = await makeProduction()); });
  afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });

  it("子文档上移一层，留在原子树里而不是掉到顶层", async () => {
    const root = await createWiki({ productionId: prodId, title: "根", body: "", createdBy: TEST_USER });
    const mid = await createWiki({ productionId: prodId, title: "中层", body: "", parentNodeId: root.nodeId, createdBy: TEST_USER });
    const leaf = await createWiki({ productionId: prodId, title: "叶", body: "", parentNodeId: mid.nodeId, createdBy: TEST_USER });

    expect(await deleteWiki(mid.id, prodId)).toEqual({ ok: true });

    const all = await listNodeLibrary(prodId);
    const moved = all.find(n => n.wikiId === leaf.id);
    expect(moved?.parentId).toBe(root.nodeId);      // 不是 null
    expect(listDramaturgySubtree(all, root.nodeId).map(n => n.wikiId)).toEqual([leaf.id]);
  });

  it("删顶层文档时子文档仍落到顶层（原语义不变）", async () => {
    const top = await createWiki({ productionId: prodId, title: "顶", body: "", createdBy: TEST_USER });
    const child = await createWiki({ productionId: prodId, title: "子", body: "", parentNodeId: top.nodeId, createdBy: TEST_USER });

    expect(await deleteWiki(top.id, prodId)).toEqual({ ok: true });

    const all = await listNodeLibrary(prodId);
    expect(all.find(n => n.wikiId === child.id)?.parentId).toBeNull();
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
    expect(cfg.rootNodeId).toBeNull();

    const rows = await getPool().query(
      "SELECT 1 FROM production_node_config WHERE production_id = $1", [prodId]);
    expect(rows.rowCount).toBe(0);
    expect(await listNodeLibrary(prodId)).toEqual([]);
  });
});

describe("POST /wiki 的 parentAnchor 落位", () => {
  let prodId: string;
  const ctx = () => ({ params: Promise.resolve({ id: prodId }) });
  const req = (body: unknown) =>
    new NextRequest(`http://localhost/api/production/${prodId}/wiki`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // isAdmin=true 只为过 create 门；本组测的是落位不是门（门另有测试）
        Cookie: `${SESSION_COOKIE}=${createSession({ userId: TEST_USER, name: "测试", avatarUrl: null, isAdmin: true })}`,
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => { ({ prodId } = await makeProduction()); });
  afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });

  it("锚点尚未懒建时，parentAnchor 补建根并把文档挂上去", async () => {
    expect((await getDramaturgyTreeConfig(prodId)).rootNodeId).toBeNull();

    const res = await wikiPOST(req({ title: "灵感一", parentAnchor: "dramaturgy" }), ctx());
    expect(res.status).toBe(201);
    const { wiki } = await res.json();

    const rootId = (await getDramaturgyTreeConfig(prodId)).rootNodeId;
    expect(rootId).not.toBeNull();
    expect((await getNodeByWikiId(wiki.id))?.parentId).toBe(rootId);
    // 落在子树里＝在「灵感文档」工作区看得见
    expect(listDramaturgySubtree(await listNodeLibrary(prodId), rootId).map(n => n.wikiId))
      .toEqual([wiki.id]);
  });

  it("锚点已存在时不重复建，复用同一个根", async () => {
    const before = (await getDramaturgyTreeConfig(prodId)).rootNodeId;
    const res = await wikiPOST(req({ title: "灵感二", parentAnchor: "dramaturgy" }), ctx());
    expect(res.status).toBe(201);
    expect((await getNodeByWikiId((await res.json()).wiki.id))?.parentId).toBe(before);
    expect((await getDramaturgyTreeConfig(prodId)).rootNodeId).toBe(before);
  });

  it("显式 parentId 压过 parentAnchor", async () => {
    const other = await createWiki({
      productionId: prodId, title: "别处", body: "", createdBy: TEST_USER });
    const res = await wikiPOST(
      req({ title: "挂在别处", parentId: other.nodeId, parentAnchor: "dramaturgy" }), ctx());
    expect(res.status).toBe(201);
    expect((await getNodeByWikiId((await res.json()).wiki.id))?.parentId).toBe(other.nodeId);
  });

  // 合法值只有一个，认不出来就 400——静默当没给会让文档落到**全库**顶层、掉出
  // 工作区，而调用方以为成功了（#355 AI review #2）。
  it("认不出的 parentAnchor 是 400，不静默落到全库顶层", async () => {
    const res = await wikiPOST(req({ title: "锚点拼错了", parentAnchor: "dramaturgi" }), ctx());
    expect(res.status).toBe(400);
    expect(await listNodeLibrary(prodId)).not.toContainEqual(
      expect.objectContaining({ displayTitle: "锚点拼错了" }));
  });

  it("不带 parentAnchor 时不碰锚点，也不建 config 行", async () => {
    const { prodId: clean } = await makeProduction();
    try {
      const res = await wikiPOST(
        new NextRequest(`http://localhost/api/production/${clean}/wiki`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `${SESSION_COOKIE}=${createSession({ userId: TEST_USER, name: "测试", avatarUrl: null, isAdmin: true })}`,
          },
          body: JSON.stringify({ title: "普通文档" }),
        }),
        { params: Promise.resolve({ id: clean }) },
      );
      expect(res.status).toBe(201);
      expect((await getNodeByWikiId((await res.json()).wiki.id))?.parentId).toBeNull();
      const cfg = await getPool().query(
        "SELECT 1 FROM production_node_config WHERE production_id = $1", [clean]);
      expect(cfg.rowCount).toBe(0);
    } finally {
      await cleanupProduction(clean).catch(() => {});
    }
  });
});

// AI review #1 指出的并发窗口：删除中途有人往被删节点下挂新子项，那个子项
// 会绕过「上移一层」、被 ON DELETE SET NULL 弹出子树。deleteNode 用行锁关掉它，
// 靠的是 PG 对 FK 被引用行取 FOR KEY SHARE——这条断言的就是这个机制本身成立
// （#420 后行锁与 parent FK 都在 node 表上）。
describe("deleteNode 的行锁确实挡住并发挂子项", () => {
  let prodId: string;

  beforeAll(async () => { ({ prodId } = await makeProduction()); });
  afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });

  it("持有被删行的 FOR UPDATE 时，并发 INSERT 子文档会被阻塞", async () => {
    const parent = await createWiki({
      productionId: prodId, title: "待删父", body: "", createdBy: TEST_USER });

    const holder = await getPool().connect();
    const racer = await getPool().connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM node WHERE id = $1 FOR UPDATE", [parent.nodeId]);

      // 另一条连接尝试挂子项：被 FK 的 FOR KEY SHARE 挡住 → 撞 statement_timeout
      await racer.query("SET statement_timeout = 900");
      await expect(racer.query(
        `INSERT INTO node (id, production_id, kind, parent_id, title)
         VALUES ('nd_racer0001', $1, 'folder', $2, '抢挂')`,
        [prodId, parent.nodeId],
      )).rejects.toThrow(/statement timeout|canceling statement/i);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      await racer.query("RESET statement_timeout").catch(() => {});
      racer.release();
    }
  });
});
