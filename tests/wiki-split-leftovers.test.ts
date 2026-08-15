import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createEventReport, updateEventReport, createReportNote,
  createReportReply, deleteReportReply, getReportReply,
} from "@/lib/event-db";
import { dispatchReportNotification, dispatchMentionNotifications } from "@/lib/notify";
import { mergeAccounts } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// wiki-split（批C PR-C1）遗留清理的回归测试：
// 1) notify 的三条 SQL 曾引用已 DROP 进 wiki 的列（title/body/content），发布/提及通知静默失败
// 2) mergeAccounts 曾 UPDATE 已 DROP 的 event_report.created_by / event_report_note.author_user_id
//    与已 DROP 的 event_report_reply 表，合并必然回滚
// 3) deleteReportReply 的 EXISTS 内层 JOIN wiki w 遮蔽外层别名，归属校验恒真（跨 report 越权删）

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

let prodId: string;
let eventId: string;
let reportA: string;
let reportB: string;
let deptId: string;
let author: string;
let mentioned: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  [author, mentioned] = await Promise.all([newUser(), newUser()]);

  eventId = `ev${shortId()}`;
  await getPool().query(
    `INSERT INTO production_event (id, production_id, title, created_by, status) VALUES ($1, $2, '排练', $3, 'published')`,
    [eventId, prodId, author],
  );
  ({ rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, '灯光') RETURNING id`,
    [prodId],
  ));
  await getPool().query(
    `INSERT INTO event_participant (id, event_id, user_id, name, department_id) VALUES ($1, $2, $3, '参与者', $4)`,
    [`ep${shortId()}`, eventId, author, deptId],
  );

  reportA = `rp${shortId()}`;
  reportB = `rp${shortId()}`;
  await createEventReport({ id: reportA, eventId, reportType: "rehearsal", title: "报告A", body: "正文A", createdBy: author });
  await createEventReport({ id: reportB, eventId, reportType: "rehearsal", title: "报告B", body: "正文B", createdBy: author });
});

afterAll(async () => {
  await getPool().query("DELETE FROM production_event WHERE id = $1", [eventId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("deleteReportReply cross-report scoping", () => {
  it("refuses to delete a reply through a different report id", async () => {
    const reply = await createReportReply({
      id: "ignored", reportId: reportA, parentType: "report", parentId: reportA,
      userId: author, authorName: "作者", content: "报告A 的评论",
    });
    await deleteReportReply(reply.id, reportB);
    expect(await getReportReply(reply.id, reportA)).not.toBeNull();

    await deleteReportReply(reply.id, reportA);
    expect(await getReportReply(reply.id, reportA)).toBeNull();
  });

  it("scopes note replies the same way", async () => {
    const noteId = `rn${shortId()}`;
    await createReportNote({
      id: noteId, reportId: reportA, departmentId: deptId,
      content: "部门 note", authorUserId: author, authorName: "作者", createdVia: "dept",
    });
    const reply = await createReportReply({
      id: "ignored", reportId: reportA, parentType: "note", parentId: noteId,
      userId: author, authorName: "作者", content: "note 的评论",
    });
    await deleteReportReply(reply.id, reportB);
    expect(await getReportReply(reply.id, reportA)).not.toBeNull();

    await deleteReportReply(reply.id, reportA);
    expect(await getReportReply(reply.id, reportA)).toBeNull();
  });
});

describe("report notifications after wiki split", () => {
  it("dispatchReportNotification reads title/body/note content from wiki", async () => {
    await updateEventReport(reportA, eventId, { publishedAt: new Date().toISOString() });
    // dryRun：只走 SQL 与消息构建，不发外部消息——回归点是 SQL 不再引用已 DROP 列
    const result = await dispatchReportNotification(reportA, eventId, prodId, true);
    expect(result.errors).toEqual([]);
  });

  it("dispatchMentionNotifications reads report title via wiki and notifies mentioned users", async () => {
    await updateEventReport(reportA, eventId, { mentions: [{ userId: mentioned, name: "被提及者" }] });
    await dispatchMentionNotifications(reportA, eventId, prodId);
    const res = await getPool().query(
      `SELECT 1 FROM user_notification WHERE user_id = $1 AND entity_type = 'report' AND entity_id = $2`,
      [mentioned, reportA],
    );
    expect(res.rows.length).toBeGreaterThan(0);
  });
});

describe("mergeAccounts after wiki split", () => {
  it("transfers wiki authorship and comment identity, then deletes the old user", async () => {
    const keep = await newUser();
    const del = await newUser();

    const mergedReport = `rp${shortId()}`;
    await createEventReport({ id: mergedReport, eventId, reportType: "rehearsal", title: "待合并", body: "x", createdBy: del });
    const reply = await createReportReply({
      id: "ignored", reportId: mergedReport, parentType: "report", parentId: mergedReport,
      userId: del, authorName: "旧账号", content: "旧账号的评论",
    });

    await mergeAccounts(keep, del);

    const wikiRes = await getPool().query<{ created_by: string }>(
      `SELECT w.created_by FROM event_report er JOIN wiki w ON w.id = er.wiki_id WHERE er.id = $1`,
      [mergedReport],
    );
    expect(wikiRes.rows[0].created_by).toBe(keep);

    const commentRes = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM wiki_comment WHERE id = $1::uuid`,
      [reply.id],
    );
    expect(commentRes.rows[0].user_id).toBe(keep);

    const userRes = await getPool().query(`SELECT 1 FROM app_user WHERE id = $1`, [del]);
    expect(userRes.rows.length).toBe(0);
  });
});
