import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { createEventReport, createReportNote, deleteEventReport } from "@/lib/event-db";
import { getWikiTreeConfig, ensureReportTreeAnchors } from "@/lib/wiki-db";
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

async function wikiRow(wikiId: string) {
  const res = await getPool().query<{ title: string | null; parent_id: string | null; is_public: boolean; sort_key: string | null }>(
    `SELECT title, parent_id::text AS parent_id, is_public, sort_key FROM wiki WHERE id = $1::uuid`,
    [wikiId],
  );
  return res.rows[0] ?? null;
}

async function reportWikiId(reportId: string): Promise<string> {
  const res = await getPool().query<{ wiki_id: string }>(
    `SELECT wiki_id::text AS wiki_id FROM event_report WHERE id = $1`, [reportId]);
  return res.rows[0].wiki_id;
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

    const eventDoc = await wikiRow(w!.parent_id!);
    expect(eventDoc?.title).toBe("八一四联排");
    expect(eventDoc?.is_public).toBe(true);
    expect(eventDoc?.parent_id).toBeTruthy();

    const root = await wikiRow(eventDoc!.parent_id!);
    expect(root?.title).toBe("报告");
    expect(root?.is_public).toBe(true);
    expect(root?.parent_id).toBeNull();

    const cfg = await getWikiTreeConfig(prodId);
    expect(cfg.rootWikiId).toBe(eventDoc!.parent_id);
  });

  it("anchors are reused (no duplicates) across reports and events", async () => {
    const r2 = `rp${shortId()}`;
    await createEventReport({ id: r2, eventId: eventA, reportType: "rehearsal", title: "联排报告二", body: "x", createdBy: creator });
    const r3 = `rp${shortId()}`;
    await createEventReport({ id: r3, eventId: eventB, reportType: "rehearsal", title: "走台报告", body: "x", createdBy: creator });

    const roots = await getPool().query(
      `SELECT 1 FROM wiki WHERE production_id = $1 AND title = '报告' AND parent_id IS NULL`, [prodId]);
    expect(roots.rows.length).toBe(1);

    const w2 = await wikiRow(await reportWikiId(r2));
    const w3 = await wikiRow(await reportWikiId(r3));
    const doc2 = await wikiRow(w2!.parent_id!);
    const doc3 = await wikiRow(w3!.parent_id!);
    expect(doc2?.title).toBe("八一四联排");
    expect(doc3?.title).toBe("八一五走台");
    expect(doc2?.parent_id).toBe(doc3?.parent_id);
  });

  it("anchor is tracked by id, not title/position (rename survives)", async () => {
    const cfg = await getWikiTreeConfig(prodId);
    await getPool().query(`UPDATE wiki SET title = '演出档案' WHERE id = $1::uuid`, [cfg.rootWikiId]);
    const again = await ensureReportTreeAnchors(prodId, eventA);
    const doc = await wikiRow(again!);
    expect(doc?.parent_id).toBe(cfg.rootWikiId);
    await getPool().query(`UPDATE wiki SET title = '报告' WHERE id = $1::uuid`, [cfg.rootWikiId]);
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
      `SELECT wiki_id::text AS wiki_id FROM event_report_note WHERE id = $1`, [noteId]);
    const w = await wikiRow(noteWiki.rows[0].wiki_id);
    expect(w?.title).toBe("灯光 · 备注");
    expect(w?.parent_id).toBe(await reportWikiId(reportId));
    expect(w?.sort_key).toBeTruthy();
  });

  it("custom parent overrides; explicit null skips placement", async () => {
    const customParent = await getPool().query<{ id: string }>(
      `INSERT INTO wiki (production_id, title, sort_key) VALUES ($1, '自定义容器', 'zzzz000000') RETURNING id::text AS id`,
      [prodId]);
    const rCustom = `rp${shortId()}`;
    await createEventReport({
      id: rCustom, eventId: eventA, reportType: "rehearsal", title: "自定义挂载",
      body: "x", createdBy: creator, parentWikiId: customParent.rows[0].id,
    });
    expect((await wikiRow(await reportWikiId(rCustom)))?.parent_id).toBe(customParent.rows[0].id);

    const rNone = `rp${shortId()}`;
    await createEventReport({
      id: rNone, eventId: eventA, reportType: "rehearsal", title: "不挂树",
      body: "x", createdBy: creator, parentWikiId: null,
    });
    expect((await wikiRow(await reportWikiId(rNone)))?.parent_id).toBeNull();
  });

  it("disabled config skips default placement", async () => {
    const { prodId: prod2 } = await makeProduction();
    try {
      await getPool().query(
        `INSERT INTO production_wiki_config (production_id, reports_tree_enabled) VALUES ($1, false)
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

  it("deleting a report removes its note wikis (no orphans floating to root)", async () => {
    const reportId = `rp${shortId()}`;
    await createEventReport({ id: reportId, eventId: eventB, reportType: "rehearsal", title: "将被删除", body: "x", createdBy: creator });
    const noteId = `rn${shortId()}`;
    await createReportNote({
      id: noteId, reportId, departmentId: deptId,
      content: "note 内容", authorUserId: creator, authorName: "作者", createdVia: "dept",
    });
    const noteWikiId = (await getPool().query<{ wiki_id: string }>(
      `SELECT wiki_id::text AS wiki_id FROM event_report_note WHERE id = $1`, [noteId])).rows[0].wiki_id;
    const rWikiId = await reportWikiId(reportId);

    await deleteEventReport(reportId, eventB);
    const remain = await getPool().query(
      `SELECT 1 FROM wiki WHERE id = ANY($1::uuid[])`, [[rWikiId, noteWikiId]]);
    expect(remain.rows.length).toBe(0);
  });
});
