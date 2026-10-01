import os from "node:os";
import path from "node:path";
import type { MigrationHook } from "../_support/global-setup";

export const SNAPSHOT_PATH = path.join(os.tmpdir(), "expense-lifecycle-migration-snapshot.json");

export type ExpenseLifecycleSnapshot = {
  productionId: string;
  actorId: string;
  cancelledExpenseId: string;
  approvedExpenseId: string;
  createdAt: string;
  approvedAt: string;
};

export const createPreMigrationData: MigrationHook<ExpenseLifecycleSnapshot>["createPreMigrationData"] =
  async ({ pool, faker, testOwner }) => {
    const productionId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
    await pool.query(
      `INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)`,
      [productionId, `报销生命周期迁移-${faker.string.alphanumeric(5)}`, testOwner],
    );
    const createdAt = "2026-01-02T03:04:05.000Z";
    const approvedAt = "2026-01-03T04:05:06.000Z";
    const cancelled = await pool.query<{ id: string }>(
      `INSERT INTO production_expense
         (production_id, title, amount, submitted_by, status, created_at, updated_at,
          resolved_at, resolved_by)
       VALUES ($1, '旧撤回报销', 12.34, $2, 'cancelled', $3, $3, $3::timestamptz + interval '1 hour', $2)
       RETURNING id`,
      [productionId, testOwner, createdAt],
    );
    const approved = await pool.query<{ id: string }>(
      `INSERT INTO production_expense
         (production_id, title, amount, submitted_by, status, escalation_chain,
          created_at, updated_at, resolved_at, resolved_by)
       VALUES ($1, '旧批准报销', 56.78, $2, 'approved', $3::jsonb, $4, $5, $5, $2)
       RETURNING id`,
      [
        productionId,
        testOwner,
        JSON.stringify([{
          stage: "owner", depth: 0, approverIds: [testOwner], canFinalize: true,
          action: "approved", actorId: testOwner, actedAt: approvedAt, comment: "旧审批意见",
        }]),
        createdAt,
        approvedAt,
      ],
    );
    return {
      productionId,
      actorId: testOwner,
      cancelledExpenseId: cancelled.rows[0].id,
      approvedExpenseId: approved.rows[0].id,
      createdAt,
      approvedAt,
    };
  };

export const cleanup: MigrationHook<ExpenseLifecycleSnapshot>["cleanup"] = async (pool, snapshot) => {
  await pool.query("DELETE FROM production WHERE id = $1", [snapshot.productionId]);
};
