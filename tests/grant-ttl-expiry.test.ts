import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember, getProductionPermissionContext, hasListAccess } from "@/lib/db";
import { getPool } from "@/lib/pg";

// TTL 回归：过期 grant 不得再通过任何权限判定读取（批0 修复）。
// 此前 resource-grant-db / db.ts 的判定读取不过滤 expires_at，
// 30分钟/1小时/1天/1周 的申请有效期形同虚设。

let prodId: string;
let userId: string;

beforeAll(async () => {
  userId = (await upsertFeishuUser(`test-open-${shortId()}`, `时效甲${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(userId));
  await addProductionMember(prodId, userId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("atomic_permission_grant 过期过滤", () => {
  it("expired atomic grant is absent from permCtx.activeGrants; valid one is present", async () => {
    await getPool().query(
      `INSERT INTO atomic_permission_grant
         (production_id, user_id, permission_key, grant_source, confirmed_by, expires_at)
       VALUES ($1, $2, 'contacts:import', 'approval', $2, '2000-01-01T00:00:00Z'),
              ($1, $2, 'milestone:create',    'approval', $2, '2099-01-01T00:00:00Z')`,
      [prodId, userId],
    );
    const access = await getProductionPermissionContext(userId, false, prodId);
    expect(access).not.toBeNull();
    expect(access!.permCtx.activeGrants.has("contacts:import" as unknown as import("@/lib/permissions").Permission)).toBe(false);
    expect(access!.permCtx.activeGrants.has("milestone:create" as unknown as import("@/lib/permissions").Permission)).toBe(true);
  });
});

describe("resource_grant 过期过滤", () => {
  it("expired edit grant fails hasListAccess; valid one passes", async () => {
    const expiredList = shortId();
    const validList = shortId();
    await getPool().query(
      `INSERT INTO cue_list (id, production_id, name, notes, created_by)
       VALUES ($1, $3, '过期表', '', $4), ($2, $3, '有效表', '', $4)`,
      [expiredList, validList, prodId, userId],
    );
    await getPool().query(
      `INSERT INTO resource_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by, expires_at)
       VALUES ($1, $2, 'cue_list', $3, '*', 'edit', 'approval', $2, '2000-01-01T00:00:00Z'),
              ($1, $2, 'cue_list', $4, '*', 'edit', 'approval', $2, '2099-01-01T00:00:00Z')`,
      [prodId, userId, expiredList, validList],
    );
    expect(await hasListAccess(expiredList, userId)).toBe(false);
    expect(await hasListAccess(validList, userId)).toBe(true);
  });
});
