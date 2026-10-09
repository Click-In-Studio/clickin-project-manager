import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { ACTIVATABLE_NODE_KEYS, activatePendingPermissions } from "@/lib/perm/permission-activation-db";
import { addProductionMember } from "@/lib/perm/member-db";
import { PAGE_PERMISSION_SCOPES } from "@/lib/perm/page-permission-scopes";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { cleanupProduction, makeProduction, shortId } from "../_support/factories";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
import { canEditProductionInstructions } from "@/lib/agent/agent-instructions";

let prodId: string;
let memberId: string;
let outsiderId: string;
let delegatedAdminId: string;
let producerId: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  memberId = (await upsertFeishuUser(`test-open-${shortId()}`, `待激活${shortId()}`, null, false)).userId;
  outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `局外人${shortId()}`, null, false)).userId;
  delegatedAdminId = (await upsertFeishuUser(`test-open-${shortId()}`, `人事管理员${shortId()}`, null, false)).userId;
  producerId = (await upsertFeishuUser(`test-open-${shortId()}`, `制作人${shortId()}`, null, false)).userId;
  await addProductionMember(prodId, memberId);
  await addProductionMember(prodId, delegatedAdminId);
  await addProductionMember(prodId, producerId);
  const roleId = `role_${shortId()}`;
  await getPool().query(
    "INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, '待激活权限')",
    [roleId, prodId],
  );
  await getPool().query(
    "INSERT INTO production_role_permission (role_id, permission_key) VALUES ($1, 'node:scene/*/synopsis@edit')",
    [roleId],
  );
  await getPool().query(
    "INSERT INTO production_member_role (production_id, user_id, role_id) VALUES ($1, $2, $3)",
    [prodId, memberId, roleId],
  );
  const delegatedRoleId = `role_${shortId()}`;
  await getPool().query(
    "INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, '人事管理员')",
    [delegatedRoleId, prodId],
  );
  await getPool().query(
    "INSERT INTO production_role_permission (role_id, permission_key) VALUES ($1, 'node:member/*@create')",
    [delegatedRoleId],
  );
  await getPool().query(
    "INSERT INTO production_member_role (production_id, user_id, role_id) VALUES ($1, $2, $3)",
    [prodId, delegatedAdminId, delegatedRoleId],
  );
  const producerRole = await getPool().query<{ id: string }>(
    "SELECT id FROM production_role WHERE production_id = $1 AND name = '制作人'",
    [prodId],
  );
  await getPool().query(
    "INSERT INTO production_member_role (production_id, user_id, role_id) VALUES ($1, $2, $3)",
    [prodId, producerId, producerRole.rows[0].id],
  );
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("权限激活共享落行入口", () => {
  it("激活目录严格等于页面 scopes 中全部 node 键的去重并集", () => {
    const expected = [
      ...new Set(
        Object.values(PAGE_PERMISSION_SCOPES).flatMap((scope) =>
          [...scope].filter((key) => key.startsWith("node:")),
        ),
      ),
    ];
    expect(ACTIVATABLE_NODE_KEYS).toEqual(expected);
    expect(new Set(ACTIVATABLE_NODE_KEYS).size).toBe(ACTIVATABLE_NODE_KEYS.length);
    expect(ACTIVATABLE_NODE_KEYS.every((key) => key.startsWith("node:"))).toBe(true);
  });

  it("只接受激活面目录内的键，并按区间资格幂等落行", async () => {
    const first = await activatePendingPermissions(memberId, prodId, ["node:scene/*/synopsis@edit"]);
    expect(first).toEqual({ ok: true, confirmed: 1 });
    const repeated = await activatePendingPermissions(memberId, prodId, ["node:scene/*/synopsis@edit"]);
    expect(repeated).toEqual({ ok: true, confirmed: 0 });
    const row = await getPool().query<{ grant_source: string; confirmed_by: string }>(
      `SELECT grant_source, confirmed_by FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2 AND resource_type = 'scene'
         AND resource_id = '*' AND resource_sub = 'synopsis' AND permission_level = 'edit' AND is_revoked = false`,
      [prodId, memberId],
    );
    expect(row.rows[0]).toEqual({ grant_source: "self_confirmed", confirmed_by: memberId });
  });

  it("非成员、目录外键与归档项目都在共享入口拒绝", async () => {
    expect(await activatePendingPermissions(outsiderId, prodId, ["node:scene/*/synopsis@edit"]))
      .toMatchObject({ ok: false, status: 403 });
    expect(await activatePendingPermissions(memberId, prodId, ["node:not_real/*@edit"]))
      .toMatchObject({ ok: false, status: 400 });
    await getPool().query("UPDATE production SET archived_at = now() WHERE id = $1", [prodId]);
    expect(await activatePendingPermissions(memberId, prodId, ["node:scene/*/synopsis@edit"]))
      .toMatchObject({ ok: false, status: 403 });
    await getPool().query("UPDATE production SET archived_at = NULL WHERE id = $1", [prodId]);
  });

  it("进入配置中心时，制作人可一次激活全部普通管理权限（含邀请成员与制作级 AI 指令）", async () => {
    const permissions = [...PAGE_PERMISSION_SCOPES.admin];
    const result = await activatePendingPermissions(producerId, prodId, permissions);
    expect(result).toEqual({ ok: true, confirmed: permissions.length });

    const inviteGrant = await getPool().query(
      `SELECT 1 FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2 AND resource_type = 'member'
         AND resource_id = '*' AND resource_sub = '*' AND permission_level = 'create'
         AND NOT is_revoked`,
      [prodId, producerId],
    );
    expect(inviteGrant.rows).toHaveLength(1);

    const instructionsGrant = await getPool().query(
      `SELECT 1 FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2 AND resource_type = 'ai_instructions'
         AND resource_id = '*' AND resource_sub = '*' AND permission_level = 'edit'
         AND NOT is_revoked`,
      [prodId, producerId],
    );
    expect(instructionsGrant.rows).toHaveLength(1);

    // 设置页直接查 hasEffectiveGrant；REST 与 Agent 写工具共用
    // canEditProductionInstructions。激活后两条消费门必须同时放行。
    const access = await getProductionPermissionContext(producerId, false, prodId);
    expect(access).not.toBeNull();
    expect(await hasEffectiveGrant(
      access!.permCtx, prodId, "ai_instructions", "*", "*", "edit",
    )).toBe(true);
    expect(await canEditProductionInstructions(producerId, prodId)).toBe(true);
  });

  it("管理权限激活按实际资格收口，不依赖制作人角色也不扩大授权", async () => {
    const result = await activatePendingPermissions(
      delegatedAdminId,
      prodId,
      [...PAGE_PERMISSION_SCOPES.admin],
    );
    expect(result).toEqual({ ok: true, confirmed: 1 });

    const grants = await getPool().query<{ key: string }>(
      `SELECT resource_type || '/' || resource_id || '/' || resource_sub || '@' || permission_level AS key
       FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2 AND NOT is_revoked
       ORDER BY key`,
      [prodId, delegatedAdminId],
    );
    expect(grants.rows.map((row) => row.key)).toEqual(["member/*/*@create"]);
  });
});
