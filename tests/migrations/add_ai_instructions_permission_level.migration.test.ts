import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import {
  SNAPSHOT_PATH,
  type AddAiInstructionsPermissionLevelSnapshot,
} from "./add_ai_instructions_permission_level.snapshot";

let snapshot: AddAiInstructionsPermissionLevelSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
} catch {
  snapshot = null;
}

describe("add ai instructions permission level migration", () => {
  it("schema: ai_instructions 只登记实际消费的 edit 动词", async () => {
    const { rows } = await getPool().query<{ permission_level: string; sort_order: number }>(
      `SELECT permission_level, sort_order
       FROM resource_permission_level
       WHERE resource_type = 'ai_instructions'
       ORDER BY permission_level`,
    );
    expect(rows).toEqual([{ permission_level: "edit", sort_order: 0 }]);
  });

  it("integrity: ai_instructions 有效 grant 均能命中权限词汇", async () => {
    const { rows } = await getPool().query(
      `SELECT g.id
       FROM production_member_grant g
       LEFT JOIN resource_permission_level rpl
         ON rpl.resource_type = g.resource_type
        AND rpl.permission_level = g.permission_level
       WHERE g.resource_type = 'ai_instructions'
         AND NOT g.is_revoked
         AND rpl.resource_type IS NULL`,
    );
    expect(rows).toEqual([]);
  });

  it.skipIf(!snapshot)("invariance: 存量制作人通配区间及成员绑定保持不变", async () => {
    const { rows } = await getPool().query<{ permission_key: string }>(
      `SELECT prp.permission_key
       FROM production_member_role pmr
       JOIN production_role_permission prp ON prp.role_id = pmr.role_id
       WHERE pmr.production_id = $1 AND pmr.user_id = $2 AND pmr.role_id = $3`,
      [snapshot!.productionId, snapshot!.userId, snapshot!.roleId],
    );
    expect(rows).toEqual([{ permission_key: "node:*/*@*" }]);
  });
});
