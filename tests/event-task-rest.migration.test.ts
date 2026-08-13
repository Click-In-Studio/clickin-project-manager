import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import {
  EVENT_TASK_REST_SNAPSHOT_PATH,
  type EventTaskRestSnapshot,
} from "./event-task-rest-snapshot";

// 批B event 域 REST 化 + tech_req→task 更名迁移三层测试。
// 快照模块顶层同步加载（skipIf 收集期求值）。

let snapshot: EventTaskRestSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(EVENT_TASK_REST_SNAPSHOT_PATH, "utf8")) as EventTaskRestSnapshot;
} catch {
  snapshot = null;
}

describe("schema verification", () => {
  it("event vocabulary is exactly the four verbs", async () => {
    const { rows } = await getPool().query<{ permission_level: string }>(
      `SELECT permission_level FROM resource_permission_level
       WHERE resource_type = 'event' ORDER BY permission_level`,
    );
    expect(rows.map((r) => r.permission_level)).toEqual(["create", "delete", "edit", "view"]);
  });

  it("tech_req vocabulary is gone; task has four verbs", async () => {
    const { rows: tr } = await getPool().query(
      `SELECT 1 FROM resource_permission_level WHERE resource_type = 'tech_req'`,
    );
    expect(tr).toHaveLength(0);
    const { rows: task } = await getPool().query<{ permission_level: string }>(
      `SELECT permission_level FROM resource_permission_level
       WHERE resource_type = 'task' ORDER BY permission_level`,
    );
    expect(task.map((r) => r.permission_level)).toEqual(["create", "delete", "edit", "view"]);
  });
});

describe("integrity verification", () => {
  it("no tech_req rows remain anywhere; no event legacy-level rows", async () => {
    for (const table of ["production_member_grant", "resource_dept_manage", "resource_person_manage"]) {
      const { rows } = await getPool().query(
        `SELECT 1 FROM ${table} WHERE resource_type = 'tech_req' LIMIT 1`,
      );
      expect(rows, `${table} 不应残留 tech_req 类型`).toHaveLength(0);
    }
    const { rows } = await getPool().query(
      `SELECT 1 FROM production_member_grant
       WHERE resource_type = 'event'
         AND permission_level IN ('manage', 'publish', 'edit_published', 'revoke') LIMIT 1`,
    );
    expect(rows).toHaveLength(0);
  });

  it("no event/task atomic keys remain in permission tables or dept arrays", async () => {
    for (const [table, col] of [
      // atomic_permission_grant 已 DROP（批G G-2 终局）——零残留恒真
      ["production_role_permission", "permission_key"],
      ["production_member_permission", "permission"],
    ] as const) {
      const { rows } = await getPool().query(
        `SELECT 1 FROM ${table}
         WHERE ${col} LIKE 'event:%' OR ${col} LIKE 'task:%' LIMIT 1`,
      );
      expect(rows, `${table} 不应残留 event/task 原子键`).toHaveLength(0);
    }
    const { rows: pd } = await getPool().query(
      `SELECT 1 FROM production_dept
       WHERE 'event:edit' = ANY(permissions) OR 'event:create' = ANY(permissions)
          OR 'tech_req:edit' = ANY(permissions) LIMIT 1`,
    );
    expect(pd).toHaveLength(0);
  });
});

describe("invariance verification", () => {
  async function rowsFor(userId: string, rtype: string, rid: string) {
    const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
      `SELECT resource_sub, permission_level FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2
         AND resource_type = $3 AND resource_id = $4 AND NOT is_revoked`,
      [snapshot!.productionId, userId, rtype, rid],
    );
    return rows.map((r) => `${r.resource_sub}@${r.permission_level}`).sort();
  }

  it.skipIf(!snapshot)("event manage row expands to the full verb row-set", async () => {
    expect(await rowsFor(snapshot!.manageUserId, "event", snapshot!.eventId)).toEqual(
      ["meta@view", "details@view", "publication@view", "*@edit",
       "tasks@create", "tasks@delete", "reports@create", "reports@delete",
       "publication@create", "publication@edit", "publication@delete", "grants@edit"].sort(),
    );
  });

  it.skipIf(!snapshot)("tech_req assign row renames to task with assign row-set", async () => {
    expect(await rowsFor(snapshot!.assignUserId, "task", snapshot!.reqId)).toEqual(
      ["*@view", "assignees@edit"].sort(),
    );
  });

  it.skipIf(!snapshot)("atomic follow/view_any convert to wildcard verb rows", async () => {
    expect(await rowsFor(snapshot!.atomicUserId, "event", "*")).toEqual(
      ["meta@view", "details@view", "followers@create"].sort(),
    );
    expect(await rowsFor(snapshot!.atomicUserId, "task", "*")).toEqual(["*@view"]);
  });

  it.skipIf(!snapshot)("role keys convert to node strings; task:view drops; chat follows create", async () => {
    const { rows } = await getPool().query<{ permission_key: string }>(
      `SELECT permission_key FROM production_role_permission WHERE role_id = $1`,
      [snapshot!.roleId],
    );
    expect(rows.map((r) => r.permission_key).sort()).toEqual([
      "node:event/*@create",
      "node:event/*/chat@create",
      "node:event/*/reports@view",
      "node:event/*/meta@view",
      "node:event/*/details@view",
      "node:event/*/followers@create",
    ].sort());
  });

  it.skipIf(!snapshot)("dept 'event:edit' pseudo-key converts to instance permission rows", async () => {
    const { rows } = await getPool().query<{ permission_key: string }>(
      `SELECT permission_key FROM production_dept_permission WHERE dept_id = $1`,
      [snapshot!.deptId],
    );
    const id = snapshot!.eventId;
    expect(rows.map((r) => r.permission_key).sort()).toEqual([
      `node:event/${id}@view`,
      `node:event/${id}@edit`,
    ].sort());
    const { rows: pd } = await getPool().query<{ permissions: string[] }>(
      `SELECT permissions FROM production_dept WHERE id = $1`, [snapshot!.deptId],
    );
    expect(pd[0].permissions).toContain("report:edit");
    expect(pd[0].permissions).not.toContain("event:edit");
  });
});
