import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { MATERIAL_ADMIN_KEYS, MATERIAL_GOVERNANCE_KEYS, MATERIAL_PERMISSION_KEYS } from "@/lib/ops/material-permission-types";
import { PAGE_PERMISSION_SCOPES } from "@/lib/perm/page-permission-scopes";
import { PRODUCER_KEYS } from "@/lib/production/templates/shared";
import { PRODUCTION_TEMPLATES } from "@/lib/production/production-template";
import { SNAPSHOT_PATH, type ExpandMaterialPermissionsSnapshot } from "./expand_material_permissions.snapshot";

let snapshot: ExpandMaterialPermissionsSnapshot | null = null;
try { snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")); } catch { snapshot = null; }

describe("expand material permissions migration", () => {
  it("schema: 新键全部进入物料激活面，制作人显式持治理键", () => {
    expect([...PAGE_PERMISSION_SCOPES.materials].sort())
      .toEqual(Object.values(MATERIAL_PERMISSION_KEYS).sort());
    for (const key of MATERIAL_GOVERNANCE_KEYS) expect(PRODUCER_KEYS).toContain(key);
    for (const template of Object.values(PRODUCTION_TEMPLATES)) {
      for (const key of MATERIAL_GOVERNANCE_KEYS)
        expect(template.roles.permissions["制作人"], template.key).toContain(key);
    }
    for (const key of MATERIAL_ADMIN_KEYS) expect(PAGE_PERMISSION_SCOPES.materials).toContain(key);
  });

  it("integrity: 旧物料专用 CRUD 区间已经退出", async () => {
    const { rows } = await getPool().query<{ key: string }>(`
      SELECT permission_key AS key FROM production_role_permission
       WHERE permission_key ~ '^node:material/[^/@]+@(create|edit|delete|\\*)$'
      UNION ALL
      SELECT permission_key FROM production_dept_permission
       WHERE permission_key ~ '^node:material/[^/@]+@(create|edit|delete|\\*)$'
      UNION ALL
      SELECT permission FROM production_member_permission
       WHERE permission ~ '^node:material/[^/@]+@(create|edit|delete|\\*)$'`);
    expect(rows).toEqual([]);
  });

  it.skipIf(!snapshot)("invariance: role 与泛型制作人区间展开，治理键不遗漏", async () => {
    const { rows } = await getPool().query<{ permission_key: string }>(
      "SELECT permission_key FROM production_role_permission WHERE role_id=$1",
      [snapshot!.roleId],
    );
    const keys = rows.map((r) => r.permission_key);
    expect(keys).toContain("node:*/*@*");
    for (const key of Object.values(MATERIAL_PERMISSION_KEYS)) expect(keys).toContain(key);
  });

  it.skipIf(!snapshot)("invariance: dept source 与个人 deny 留在各自来源层", async () => {
    const dept = await getPool().query<{ permission_key: string; source: string }>(
      "SELECT permission_key,source FROM production_dept_permission WHERE dept_id=$1",
      [snapshot!.deptId],
    );
    for (const key of MATERIAL_ADMIN_KEYS.slice(1))
      expect(dept.rows).toContainEqual({ permission_key: key, source: "resource" });
    const member = await getPool().query<{ granted: boolean }>(
      "SELECT granted FROM production_member_permission WHERE production_id=$1 AND user_id=$2 AND permission=$3",
      [snapshot!.productionId, snapshot!.userId, MATERIAL_PERMISSION_KEYS.definitionDelete],
    );
    expect(member.rows).toEqual([{ granted: false }]);
  });

  it.skipIf(!snapshot)("invariance: active grant 原元数据展开且旧行撤销", async () => {
    const { rows } = await getPool().query<{
      resource_sub: string; is_revoked: boolean; grant_source: string;
      confirmed_by: string | null; expires_at: Date | null;
    }>(
      `SELECT resource_sub,is_revoked,grant_source,confirmed_by,expires_at
         FROM production_member_grant
        WHERE production_id=$1 AND user_id=$2 AND resource_type='material'`,
      [snapshot!.productionId, snapshot!.userId],
    );
    expect(rows.find((r) => r.resource_sub === "*")?.is_revoked).toBe(true);
    const active = rows.filter((r) => !r.is_revoked);
    expect(active.map((r) => r.resource_sub).sort()).toEqual([
      "circulation/checkouts", "circulation/returns", "definition", "identifiers",
      "maintenance", "receipts", "sources", "stock/adjustments", "stock/exits",
    ].sort());
    expect(active.every((r) => r.grant_source === "self_confirmed"
      && r.confirmed_by === snapshot!.userId
      && r.expires_at?.toISOString() === snapshot!.grantExpiresAt)).toBe(true);
  });
});
