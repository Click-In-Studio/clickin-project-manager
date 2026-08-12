import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { REPORT_NOTE_REST_SNAPSHOT_PATH, type ReportNoteRestSnapshot } from "./report-note-rest-snapshot";

// 批C PR-C2：report/note 域权限迁移三层测试（快照顶层同步加载）。

let snapshot: ReportNoteRestSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(REPORT_NOTE_REST_SNAPSHOT_PATH, "utf8")) as ReportNoteRestSnapshot;
} catch { snapshot = null; }

describe("schema verification", () => {
  it("report/note vocabularies are pure verbs", async () => {
    const { rows: rep } = await getPool().query<{ permission_level: string }>(
      `SELECT permission_level FROM resource_permission_level
       WHERE resource_type = 'report' ORDER BY permission_level`,
    );
    expect(rep.map((r) => r.permission_level)).toEqual(["create", "delete", "edit", "view"]);
    const { rows: note } = await getPool().query<{ permission_level: string }>(
      `SELECT permission_level FROM resource_permission_level
       WHERE resource_type = 'note' ORDER BY permission_level`,
    );
    expect(note.map((r) => r.permission_level)).toEqual(["create", "delete", "edit", "view"]);
  });
});

describe("integrity verification", () => {
  it("no report atomic keys or legacy-level rows remain; dept pseudo-key gone", async () => {
    for (const [table, col] of [
      ["atomic_permission_grant", "permission_key"],
      ["production_role_permission", "permission_key"],
      ["production_member_permission", "permission"],
    ] as const) {
      const { rows } = await getPool().query(
        `SELECT 1 FROM ${table} WHERE ${col} LIKE 'report:%' LIMIT 1`,
      );
      expect(rows, `${table} 不应残留 report 原子键`).toHaveLength(0);
    }
    const { rows: lv } = await getPool().query(
      `SELECT 1 FROM resource_grant
       WHERE (resource_type = 'report' AND permission_level IN ('manage','publish','edit_published','revoke'))
          OR (resource_type = 'note' AND permission_level = 'manage') LIMIT 1`,
    );
    expect(lv).toHaveLength(0);
    const { rows: pd } = await getPool().query(
      `SELECT 1 FROM production_dept WHERE 'report:edit' = ANY(permissions) LIMIT 1`,
    );
    expect(pd, "最后一枚 dept 伪键应已清除").toHaveLength(0);
  });
});

describe("invariance verification", () => {
  async function rowsFor(userId: string, rtype: string, rid: string) {
    const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
      `SELECT resource_sub, permission_level FROM resource_grant
       WHERE production_id = $1 AND user_id = $2
         AND resource_type = $3 AND resource_id = $4 AND NOT is_revoked`,
      [snapshot!.productionId, userId, rtype, rid],
    );
    return rows.map((r) => `${r.resource_sub}@${r.permission_level}`).sort();
  }

  it.skipIf(!snapshot)("report manage row expands to the full verb row-set", async () => {
    expect(await rowsFor(snapshot!.manageUserId, "report", snapshot!.reportId)).toEqual(
      ["meta@view", "publication@view", "*@edit", "notes@create", "notes@delete",
       "publication@create", "publication@edit", "publication@delete", "grants@edit"].sort(),
    );
  });

  it.skipIf(!snapshot)("atomic report keys convert to attach/replies wildcard rows", async () => {
    expect(await rowsFor(snapshot!.atomicUserId, "event", "*")).toEqual(["reports@create"]);
    expect(await rowsFor(snapshot!.atomicUserId, "report", "*")).toEqual(["replies@create"]);
  });

  it.skipIf(!snapshot)("role report keys convert to node strings", async () => {
    const { rows } = await getPool().query<{ permission_key: string }>(
      `SELECT permission_key FROM production_role_permission WHERE role_id = $1`,
      [snapshot!.roleId],
    );
    expect(rows.map((r) => r.permission_key).sort()).toEqual([
      "node:event/*/reports@create",
      "node:report/*/replies@create",
    ].sort());
  });

  it.skipIf(!snapshot)("dept 'report:edit' pseudo-key converts to instance permission rows", async () => {
    const { rows } = await getPool().query<{ permission_key: string }>(
      `SELECT permission_key FROM production_dept_permission WHERE dept_id = $1`,
      [snapshot!.deptId],
    );
    const id = snapshot!.reportId;
    expect(rows.map((r) => r.permission_key).sort()).toEqual([
      `node:report/${id}@view`,
      `node:report/${id}@edit`,
    ].sort());
  });
});
