import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { createEventReport, createReportNote, deleteEventReport, mountWikiAsReport } from "@/lib/event-db";
import { createWiki } from "@/lib/wiki/content";
import { getReportsTreeConfig, ensureReportTreeAnchors } from "@/lib/node/anchors";
import { listNodeLibrary } from "@/lib/node/db";
import { deleteWiki } from "@/lib/wiki/content";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// 默认文档树（拍板 §4-9）：报告默认挂「报告」/「<event>」之下、note 挂报告文档下、
// 锚点懒建且幂等、配置可关、自定义挂载除外、删除不留孤儿。

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

async function newEvent(prodId: string, title: string, creator: string): Promise<string> {
  const id = `ev${shortId()}`;
  await getPool().query(
    `INSERT INTO production_event (id, production_id, title, created_by, status) VALUES ($1, $2, $3, $4, 'published')`,
    [id, prodId, title, creator],
  );
  return id;
}

// #420：树位置/权限位在壳节点上。parent_id 是 **node id** 空间；沿链上溯用 nodeRow。
type Row = { node_id: string; wiki_id: string | null; title: string | null; parent_id: string | null; is_public: boolean; sort_key: string | null };
async function nodeRow(nodeId: string): Promise<Row | null> {
  const res = await getPool().query<Row>(
    `SELECT n.id AS node_id, n.wiki_id::text AS wiki_id, COALESCE(w.title, n.title) AS title,
            n.parent_id, n.is_public, n.sort_key
     FROM node n LEFT JOIN wiki w ON w.id = n.wiki_id WHERE n.id = $1`,
    [nodeId],
  );
  return res.rows[0] ?? null;
}
async function wikiRow(wikiId: string) {
  const res = await getPool().query<Row>(
    `SELECT n.id AS node_id, n.wiki_id::text AS wiki_id, w.title, n.parent_id, n.is_public, n.sort_key
     FROM node n JOIN wiki w ON w.id = n.wiki_id WHERE n.wiki_id = $1::uuid`,
    [wikiId],
  );
  return res.rows[0] ?? null;
}

async function reportWikiId(reportId: string): Promise<string> {
  const res = await getPool().query<{ wiki_id: string }>(
    `SELECT nd.wiki_id::text AS wiki_id FROM event_report er JOIN node nd ON nd.id = er.node_id
     WHERE er.id = $1`, [reportId]);
  return res.rows[0].wiki_id;
}
async function reportNodeId(reportId: string): Promise<string> {
  const res = await getPool().query<{ node_id: string }>(
    `SELECT node_id FROM event_report WHERE id = $1`, [reportId]);
  return res.rows[0].node_id;
}

let prodId: string;
let creator: string;
let eventA: string;
let eventB: string;
let deptId: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  creator = await newUser();
  eventA = await newEvent(prodId, "八一四联排", creator);
  eventB = await newEvent(prodId, "八一五走台", creator);
  ({ rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, '灯光') RETURNING id`, [prodId]));
});

afterAll(async () => {
  await getPool().query(`DELETE FROM production_event WHERE production_id = $1`, [prodId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query(`DELETE FROM app_user WHERE id = $1`, [creator]).catch(() => {});
});

describe("default report tree", () => {
  it("report lands under 报告/<event>/, anchors are public ordinary wikis", async () => {
    const reportId = `rp${shortId()}`;
    await createEventReport({
      id: reportId, eventId: eventA, reportType: "rehearsal",
      title: "联排报告一", body: "x", createdBy: creator,
    });
    const w = await wikiRow(await reportWikiId(reportId));
    expect(w?.parent_id).toBeTruthy();

    const eventDoc = await nodeRow(w!.parent_id!);
    expect(eventDoc?.title).toBe("八一四联排");
    expect(eventDoc?.is_public).toBe(true);
    expect(eventDoc?.parent_id).toBeTruthy();

    const root = await nodeRow(eventDoc!.parent_id!);
    expect(root?.title).toBe("报告");
    expect(root?.is_public).toBe(true);
    expect(root?.parent_id).toBeNull();

    const cfg = await getReportsTreeConfig(prodId);
    expect(cfg.rootNodeId).toBe(eventDoc!.parent_id);
  });

  it("anchors are reused (no duplicates) across reports and events", async () => {
    const r2 = `rp${shortId()}`;
    await createEventReport({ id: r2, eventId: eventA, reportType: "rehearsal", title: "联排报告二", body: "x", createdBy: creator });
    const r3 = `rp${shortId()}`;
    await createEventReport({ id: r3, eventId: eventB, reportType: "rehearsal", title: "走台报告", body: "x", createdBy: creator });

    const roots = await getPool().query(
      `SELECT 1 FROM node n JOIN wiki w ON w.id = n.wiki_id
       WHERE n.production_id = $1 AND w.title = '报告' AND n.parent_id IS NULL`, [prodId]);
    expect(roots.rows.length).toBe(1);

    const w2 = await wikiRow(await reportWikiId(r2));
    const w3 = await wikiRow(await reportWikiId(r3));
    const doc2 = await nodeRow(w2!.parent_id!);
    const doc3 = await nodeRow(w3!.parent_id!);
    expect(doc2?.title).toBe("八一四联排");
    expect(doc3?.title).toBe("八一五走台");
    expect(doc2?.parent_id).toBe(doc3?.parent_id);
  });

  it("anchor is tracked by id, not title/position (rename survives)", async () => {
    const cfg = await getReportsTreeConfig(prodId);
    const rootWikiId = (await nodeRow(cfg.rootNodeId!))!.wiki_id!;
    await getPool().query(`UPDATE wiki SET title = '演出档案' WHERE id = $1::uuid`, [rootWikiId]);
    const again = await ensureReportTreeAnchors(prodId, eventA);
    const doc = await nodeRow(again!);
    expect(doc?.parent_id).toBe(cfg.rootNodeId);
    await getPool().query(`UPDATE wiki SET title = '报告' WHERE id = $1::uuid`, [rootWikiId]);
  });

  it("note wiki gets title '<部门> · 备注' and parents under the report wiki", async () => {
    const reportId = `rp${shortId()}`;
    await createEventReport({ id: reportId, eventId: eventA, reportType: "rehearsal", title: "带备注的报告", body: "x", createdBy: creator });
    const noteId = `rn${shortId()}`;
    await createReportNote({
      id: noteId, reportId, departmentId: deptId,
      content: "灯位需要调整", authorUserId: creator, authorName: "作者", createdVia: "dept",
    });
    const noteWiki = await getPool().query<{ wiki_id: string }>(
      `SELECT nd.wiki_id::text AS wiki_id FROM event_report_note n JOIN node nd ON nd.id = n.node_id
       WHERE n.id = $1`, [noteId]);
    const w = await wikiRow(noteWiki.rows[0].wiki_id);
    expect(w?.title).toBe("灯光 · 备注");
    expect(w?.parent_id).toBe(await reportNodeId(reportId));
    expect(w?.sort_key).toBeTruthy();
  });

  it("custom parent overrides; explicit null skips placement", async () => {
    const customParent = await createWiki({ productionId: prodId, title: "自定义容器", createdBy: creator });
    const rCustom = `rp${shortId()}`;
    await createEventReport({
      id: rCustom, eventId: eventA, reportType: "rehearsal", title: "自定义挂载",
      body: "x", createdBy: creator, parentNodeId: customParent.nodeId,
    });
    expect((await wikiRow(await reportWikiId(rCustom)))?.parent_id).toBe(customParent.nodeId);

    const rNone = `rp${shortId()}`;
    await createEventReport({
      id: rNone, eventId: eventA, reportType: "rehearsal", title: "不挂树",
      body: "x", createdBy: creator, parentNodeId: null,
    });
    expect((await wikiRow(await reportWikiId(rNone)))?.parent_id).toBeNull();
  });

  it("disabled config skips default placement", async () => {
    const { prodId: prod2 } = await makeProduction();
    try {
      await getPool().query(
        `INSERT INTO production_node_config (production_id, reports_tree_enabled) VALUES ($1, false)
         ON CONFLICT (production_id) DO UPDATE SET reports_tree_enabled = false`,
        [prod2]);
      const ev = await newEvent(prod2, "关树事件", creator);
      const rid = `rp${shortId()}`;
      await createEventReport({ id: rid, eventId: ev, reportType: "rehearsal", title: "无树报告", body: "x", createdBy: creator });
      expect((await wikiRow(await reportWikiId(rid)))?.parent_id).toBeNull();
      await getPool().query(`DELETE FROM production_event WHERE production_id = $1`, [prod2]);
    } finally {
      await cleanupProduction(prod2).catch(() => {});
    }
  });

  it("anchor docs (root/event dir) cannot be deleted and are flagged in library list", async () => {
    const eventDocId = await ensureReportTreeAnchors(prodId, eventA);
    const cfg = await getReportsTreeConfig(prodId);
    // deleteWiki 吃内容 id：经 nodeRow 反查
    const rootWikiId = (await nodeRow(cfg.rootNodeId!))!.wiki_id!;
    const eventDocWikiId = (await nodeRow(eventDocId!))!.wiki_id!;
    expect(await deleteWiki(rootWikiId, prodId)).toEqual({ ok: false, reason: "anchor" });
    expect(await deleteWiki(eventDocWikiId, prodId)).toEqual({ ok: false, reason: "anchor" });

    const list = await listNodeLibrary(prodId);
    const byId = new Map(list.map(n => [n.id, n]));
    expect(byId.get(cfg.rootNodeId!)?.isAnchor).toBe(true);
    expect(byId.get(eventDocId!)?.isAnchor).toBe(true);
    // 普通文档不带锚点标记
    expect(list.some(n => !n.isAnchor)).toBe(true);
  });

  it("deleting a report unmounts (edge dies, docs survive; author takes over via wiki rows)", async () => {
    // W5 统一日：删除=解除挂载≠删文档；作者行集接管（§0.9 C-7）
    const reportId = `rp${shortId()}`;
    await createEventReport({ id: reportId, eventId: eventB, reportType: "rehearsal", title: "将被解除挂载", body: "x", createdBy: creator });
    const noteId = `rn${shortId()}`;
    await createReportNote({
      id: noteId, reportId, departmentId: deptId,
      content: "note 内容", authorUserId: creator, authorName: "作者", createdVia: "dept",
    });
    const noteWikiId = (await getPool().query<{ wiki_id: string }>(
      `SELECT nd.wiki_id::text AS wiki_id FROM event_report_note n JOIN node nd ON nd.id = n.node_id
       WHERE n.id = $1`, [noteId])).rows[0].wiki_id;
    const rWikiId = await reportWikiId(reportId);
    const rNodeId = await reportNodeId(reportId);

    await deleteEventReport(reportId, eventB);

    // 边亡
    const edges = await getPool().query(
      `SELECT 1 FROM event_report WHERE id = $1 UNION ALL SELECT 1 FROM event_report_note WHERE id = $2`,
      [reportId, noteId]);
    expect(edges.rows.length).toBe(0);
    // 文档存（树位置保留：note wiki 仍是报告文档的子文档）
    const noteRow = await wikiRow(noteWikiId);
    expect((await wikiRow(rWikiId))).not.toBeNull();
    expect(noteRow?.parent_id).toBe(rNodeId);
    // 作者行集接管：creator 获 wiki manage 行（含 grants@edit 保留段）
    const grants = await getPool().query(
      `SELECT 1 FROM production_member_grant
       WHERE resource_type = 'wiki' AND resource_id = $1 AND user_id = $2
         AND resource_sub = 'grants' AND permission_level = 'edit' AND NOT is_revoked`,
      [rWikiId, creator]);
    expect(grants.rows.length).toBe(1);
    // 边节点权限死行清理
    const deadRows = await getPool().query(
      `SELECT 1 FROM production_member_grant WHERE resource_type = 'report' AND resource_id = $1`,
      [reportId]);
    expect(deadRows.rows.length).toBe(0);
  });

  it("mounting an existing library doc as report keeps its tree position (W5)", async () => {
    const doc = await createWiki({ productionId: prodId, title: "既有文档", body: "内容", createdBy: creator });
    const before = await wikiRow(doc.id);
    const reportId = `rp${shortId()}`;
    const mounted = await mountWikiAsReport({
      id: reportId, eventId: eventA, wikiId: doc.id, reportType: "rehearsal", createdBy: creator,
    });
    expect(mounted?.wikiId).toBe(doc.id);
    expect(mounted?.title).toBe("既有文档");
    // 文档树位置不动（自定义挂载语义：不被默认树搬走）
    const after = await wikiRow(doc.id);
    expect(after?.parent_id).toBe(before?.parent_id);
    // 跨 production 拒绝
    const { prodId: otherProd } = await makeProduction();
    try {
      const foreign = await createWiki({ productionId: otherProd, title: "外部文档", createdBy: creator });
      expect(await mountWikiAsReport({
        id: `rp${shortId()}`, eventId: eventA, wikiId: foreign.id, reportType: "rehearsal", createdBy: creator,
      })).toBeNull();
    } finally {
      await cleanupProduction(otherProd).catch(() => {});
    }
  });

  it("event rename propagates to its report-tree directory doc title", async () => {
    const eventDocId = await ensureReportTreeAnchors(prodId, eventA);
    const { updateProductionEvent } = await import("@/lib/event-db");
    await updateProductionEvent(eventA, prodId, { title: "八一四联排（改）" });
    expect((await nodeRow(eventDocId!))?.title).toBe("八一四联排（改）");
    await updateProductionEvent(eventA, prodId, { title: "八一四联排" });
  });
});
