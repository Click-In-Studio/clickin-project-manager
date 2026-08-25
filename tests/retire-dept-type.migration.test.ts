/**
 * org_dept 类型退役并入 dept（#327）——三层迁移测试。
 *
 * 层 1 schema：org_dept 词汇行消失、dept 四动词在位
 * 层 2 完整性：全库零 org_dept 残留（授权行 / 三张区间表 / 在途申请 / 审批人配置）
 * 层 3 invariance：工厂数据迁移前后一一对应——id 位与 sub 位原样保留、撞行去重只剩
 *   一条、**notes 面一个字都没动**（本次方向选择的核心收益，反过来做就得改它）
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import {
  RETIRE_DEPT_TYPE_SNAPSHOT_PATH,
  type RetireDeptTypeSnapshot,
} from "./retire-dept-type-snapshot";

let snapshot: RetireDeptTypeSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(RETIRE_DEPT_TYPE_SNAPSHOT_PATH, "utf8")) as RetireDeptTypeSnapshot;
} catch { snapshot = null; }

describe("schema verification", () => {
  it("org_dept 词汇行已删，dept 承接四动词", async () => {
    const { rows: gone } = await getPool().query(
      `SELECT 1 FROM resource_permission_level WHERE resource_type = 'org_dept'`,
    );
    expect(gone).toHaveLength(0);

    const { rows: dept } = await getPool().query<{ permission_level: string }>(
      `SELECT permission_level FROM resource_permission_level
       WHERE resource_type = 'dept' ORDER BY permission_level`,
    );
    expect(dept.map((r) => r.permission_level)).toEqual(["create", "delete", "edit", "view"]);
  });
});

describe("integrity verification", () => {
  it("全库零 org_dept 残留", async () => {
    for (const [table, col] of [
      ["production_member_grant", "resource_type"],
      ["approval_request", "resource_type"],
      ["resource_dept_manage", "resource_type"],
      ["resource_person_manage", "resource_type"],
    ] as const) {
      const { rows } = await getPool().query(
        `SELECT 1 FROM ${table} WHERE ${col} = 'org_dept' LIMIT 1`,
      );
      expect(rows, `${table}.${col} 不应残留 org_dept`).toHaveLength(0);
    }
    for (const [table, col] of [
      ["production_dept_permission", "permission_key"],
      ["production_role_permission", "permission_key"],
      ["production_member_permission", "permission"],
    ] as const) {
      const { rows } = await getPool().query(
        `SELECT 1 FROM ${table} WHERE ${col} LIKE 'node:org_dept/%' LIMIT 1`,
      );
      expect(rows, `${table}.${col} 不应残留 org_dept 节点键`).toHaveLength(0);
    }
  });

  it("dept 授权行没有锚在不存在的部门上", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM production_member_grant g
      WHERE g.resource_type = 'dept' AND g.resource_id <> '*'
        AND NOT EXISTS (SELECT 1 FROM production_dept pd WHERE pd.id::text = g.resource_id)
      LIMIT 5
    `);
    expect(rows).toHaveLength(0);
  });
});

describe("invariance verification", () => {
  async function grantRows(resourceId: string) {
    const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
      `SELECT resource_sub, permission_level FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2
         AND resource_type = 'dept' AND resource_id = $3 AND NOT is_revoked
       ORDER BY resource_sub, permission_level`,
      [snapshot!.prodId, snapshot!.userId, resourceId],
    );
    return rows.map((r) => `${r.resource_sub}@${r.permission_level}`);
  }

  it.skipIf(!snapshot)("通配行与实例行都平移到 dept，id 位与 sub 位原样保留", async () => {
    expect(await grantRows("*")).toEqual(["grants@edit", "members@create"]);
    // 锚在具体部门上的那条：id 位没被顺手改成 '*'
    expect(await grantRows(snapshot!.deptId)).toEqual(["notes@create", "poc@create"]);
  });

  it.skipIf(!snapshot)("撞行去重后只剩一条（唯一索引没被炸）", async () => {
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2 AND resource_type = 'dept'
         AND resource_id = '*' AND resource_sub = 'grants' AND permission_level = 'edit'
         AND NOT is_revoked`,
      [snapshot!.prodId, snapshot!.userId],
    );
    expect(rows[0].n).toBe("1");
  });

  it.skipIf(!snapshot)("notes 面一个字都没动（本次并类型方向的核心收益）", async () => {
    const { rows } = await getPool().query<{ grant_source: string }>(
      `SELECT grant_source FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2 AND resource_type = 'dept'
         AND resource_id = $3 AND resource_sub = 'notes' AND permission_level = 'create'
         AND NOT is_revoked`,
      [snapshot!.prodId, snapshot!.userId, snapshot!.deptId],
    );
    // grant_source 仍是 auto：迁移没有重发这行，也没把它降级成 direct
    expect(rows.map((r) => r.grant_source)).toEqual(["auto"]);
  });

  it.skipIf(!snapshot)("三张区间表的节点键改写，sub 位与动词位不变", async () => {
    const role = await getPool().query<{ permission_key: string }>(
      `SELECT permission_key FROM production_role_permission WHERE role_id = $1`,
      [snapshot!.roleId],
    );
    expect(role.rows.map((r) => r.permission_key)).toEqual(["node:dept/*@create"]);

    const dept = await getPool().query<{ permission_key: string }>(
      `SELECT permission_key FROM production_dept_permission WHERE dept_id = $1`,
      [snapshot!.deptId],
    );
    expect(dept.rows.map((r) => r.permission_key)).toEqual(["node:dept/*/members@create"]);

    const member = await getPool().query<{ permission: string }>(
      `SELECT permission FROM production_member_permission
       WHERE production_id = $1 AND user_id = $2`,
      [snapshot!.prodId, snapshot!.userId],
    );
    expect(member.rows.map((r) => r.permission)).toEqual(["node:dept/*@delete"]);
  });

  it.skipIf(!snapshot)("在途申请改写——批准时不会发出死类型授权", async () => {
    const { rows } = await getPool().query<{ resource_type: string; resource_sub: string }>(
      `SELECT resource_type, resource_sub FROM approval_request WHERE id = $1::uuid`,
      [snapshot!.approvalId],
    );
    expect(rows[0]).toEqual({ resource_type: "dept", resource_sub: "members" });
  });

  it.skipIf(!snapshot)("资源审批人配置（#262 两张表）跟着改写", async () => {
    const d = await getPool().query<{ resource_type: string }>(
      `SELECT resource_type FROM resource_dept_manage WHERE production_id = $1 AND dept_id = $2`,
      [snapshot!.prodId, snapshot!.deptId],
    );
    expect(d.rows.map((r) => r.resource_type)).toEqual(["dept"]);

    const p = await getPool().query<{ resource_type: string }>(
      `SELECT resource_type FROM resource_person_manage WHERE production_id = $1 AND user_id = $2`,
      [snapshot!.prodId, snapshot!.userId],
    );
    expect(p.rows.map((r) => r.resource_type)).toEqual(["dept"]);
  });
});
