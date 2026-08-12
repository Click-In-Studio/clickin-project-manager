/**
 * Pre-migration snapshot for migrate-report-note-wiki-split invariance（批C PR-C1）.
 * PRE 判据：event_report 仍有 body 列。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const WIKI_SPLIT_SNAPSHOT_PATH = path.join(os.tmpdir(), "wiki-split-migration-snapshot.json");

export type WikiSplitSnapshot = {
  productionId: string;
  eventId: string;
  reportId: string;
  noteId: string;
  reportTitle: string;
  reportBody: string;
  noteContent: string;
  noteAuthorId: string;
  replyContent: string;
};

export async function isWikiSplitPreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'event_report' AND column_name = 'body'`,
  );
  return rows.length > 0;
}

export async function createWikiSplitPreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<WikiSplitSnapshot> {
  const productionId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query("INSERT INTO production (id, name) VALUES ($1, $2)", [
    productionId, `批C拆分工厂-${faker.string.alphanumeric(4)}`,
  ]);
  const eventId = `ev_${faker.string.alphanumeric(8)}`;
  await pool.query(
    `INSERT INTO production_event (id, production_id, title, status, created_by, start_time, end_time)
     VALUES ($1, $2, '批C事件', 'draft', $3, NOW(), NOW() + interval '1 hour')`,
    [eventId, productionId, testUserId],
  );
  const reportId = `rpt_${faker.string.alphanumeric(8)}`;
  const reportTitle = `拆分报告${faker.string.alphanumeric(4)}`;
  const reportBody = `报告正文${faker.string.alphanumeric(8)}`;
  await pool.query(
    `INSERT INTO event_report (id, event_id, report_type, title, body, created_by)
     VALUES ($1, $2, 'rehearsal', $3, $4, $5)`,
    [reportId, eventId, reportTitle, reportBody, testUserId],
  );
  const deptId = `ed_${faker.string.alphanumeric(8)}`;
  await pool.query(
    "INSERT INTO event_department (id, production_id, name) VALUES ($1, $2, $3)",
    [deptId, productionId, `批C部门${faker.string.alphanumeric(4)}`],
  );
  const noteId = `nt_${faker.string.alphanumeric(8)}`;
  const noteContent = `note内容${faker.string.alphanumeric(8)}`;
  await pool.query(
    `INSERT INTO event_report_note (id, report_id, department_id, content, author_user_id, author_name)
     VALUES ($1, $2, $3, $4, $5, '测试系统用户')`,
    [noteId, reportId, deptId, noteContent, testUserId],
  );
  const replyContent = `评论${faker.string.alphanumeric(8)}`;
  await pool.query(
    `INSERT INTO event_report_reply (id, report_id, parent_type, parent_id, user_id, author_name, content)
     VALUES ($1, $2, 'note', $3, $4, '测试系统用户', $5)`,
    [`rr_${faker.string.alphanumeric(8)}`, reportId, noteId, testUserId, replyContent],
  );
  return { productionId, eventId, reportId, noteId, reportTitle, reportBody, noteContent, noteAuthorId: testUserId, replyContent };
}
