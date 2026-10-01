import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { SNAPSHOT_PATH, type ExpenseLifecycleSnapshot } from "./expense_lifecycle.snapshot";

let snapshot: ExpenseLifecycleSnapshot | null = null;
try { snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as ExpenseLifecycleSnapshot; }
catch { snapshot = null; }

describe("schema verification", () => {
  it("报销支持草稿、并发序号和提交时间，金额可在草稿阶段为空", async () => {
    const columns = await getPool().query<{
      column_name: string; is_nullable: string; column_default: string | null;
    }>(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'production_expense'
          AND column_name = ANY($1::text[])
        ORDER BY column_name`,
      [["amount", "mutation_seq", "submitted_at", "status"]],
    );
    expect(columns.rows).toEqual([
      { column_name: "amount", is_nullable: "YES", column_default: null },
      { column_name: "mutation_seq", is_nullable: "NO", column_default: "0" },
      { column_name: "status", is_nullable: "NO", column_default: "'draft'::text" },
      { column_name: "submitted_at", is_nullable: "YES", column_default: null },
    ]);
  });

  it("永久事件表和按报销时间线索引已建立", async () => {
    const table = await getPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'production_expense_event'`,
    );
    expect(table.rows).toHaveLength(1);
    const index = await getPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'production_expense_event_expense_idx'`,
    );
    expect(index.rows).toHaveLength(1);
  });
});

describe("integrity verification", () => {
  it("非草稿不能缺标题、金额或提交时间", async () => {
    const productionId = snapshot?.productionId
      ?? (await getPool().query<{ id: string }>("SELECT id FROM production LIMIT 1")).rows[0]?.id;
    if (!productionId) return;
    await expect(getPool().query(
      `INSERT INTO production_expense (production_id, submitted_by, status)
       SELECT $1, owner_id, 'pending' FROM production WHERE id = $1`,
      [productionId],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("事件不存在悬空报销引用，事件类型均在约束内", async () => {
    const orphan = await getPool().query(
      `SELECT ev.id FROM production_expense_event ev
       LEFT JOIN production_expense e ON e.id = ev.expense_id
       WHERE e.id IS NULL LIMIT 1`,
    );
    expect(orphan.rows).toHaveLength(0);
    const invalid = await getPool().query(
      `SELECT id FROM production_expense_event WHERE event_type NOT IN (
         'draft_created', 'draft_saved', 'submitted', 'forwarded', 'approved', 'rejected',
         'withdrawn', 'reopened', 'document_added', 'document_removed',
         'post_approval_document_added'
       ) LIMIT 1`,
    );
    expect(invalid.rows).toHaveLength(0);
  });
});

describe("invariance verification", () => {
  it.skipIf(!snapshot)("旧 cancelled 映射为 withdrawn，并保留提交与终局事实", async () => {
    const expense = await getPool().query<{
      status: string; submitted_at: Date; mutation_seq: string;
    }>(
      `SELECT status, submitted_at, mutation_seq FROM production_expense WHERE id = $1`,
      [snapshot!.cancelledExpenseId],
    );
    expect(expense.rows[0]).toMatchObject({ status: "withdrawn", mutation_seq: "0" });
    expect(expense.rows[0].submitted_at.toISOString()).toBe(snapshot!.createdAt);
    const events = await getPool().query<{ event_type: string; actor_id: string }>(
      `SELECT event_type, actor_id FROM production_expense_event
        WHERE expense_id = $1 ORDER BY created_at, id`,
      [snapshot!.cancelledExpenseId],
    );
    expect(events.rows).toEqual([
      { event_type: "submitted", actor_id: snapshot!.actorId },
      { event_type: "withdrawn", actor_id: snapshot!.actorId },
    ]);
  });

  it.skipIf(!snapshot)("旧审批链动作只生成一条终局事件并保留意见与处理人", async () => {
    const events = await getPool().query<{
      event_type: string; actor_id: string; comment: string | null; created_at: Date;
    }>(
      `SELECT event_type, actor_id, comment, created_at FROM production_expense_event
        WHERE expense_id = $1 AND event_type = 'approved'`,
      [snapshot!.approvedExpenseId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      event_type: "approved", actor_id: snapshot!.actorId, comment: "旧审批意见",
    });
    expect(events.rows[0].created_at.toISOString()).toBe(snapshot!.approvedAt);
  });
});
