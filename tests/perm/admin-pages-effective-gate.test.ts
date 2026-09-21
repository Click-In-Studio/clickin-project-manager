/**
 * #604 第一批配套：admin 页面群（settings / organization / roles / permissions / audit /
 * asset-review / policies / templates / migration / danger / producer / announcements /
 * milestones）的入口开关全部改走 `hasEffectiveGrant(permCtx, ...)`，permCtx 来自
 * `getProductionPermissionContext`。本文件钉住页面所依赖的那条链的两个边界：
 *   - owner 非成员、零 grant 行 → 所有键放行（漏 owner 的原病）；
 *   - 普通成员只持单枚键 → 只有那枚亮，邻键不亮（旁路不得泛化成「进了 admin 就全亮」）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
import { getPool } from "@/lib/pg";

let prodId: string;
let ownerId: string;
let memberId: string;

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `owner${shortId()}`, null, false)).userId;
  memberId = (await upsertFeishuUser(`test-open-${shortId()}`, `member${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  // owner 刻意不进 production_member：复现「owner 可以不是成员」
  await getPool().query("DELETE FROM production_member WHERE production_id = $1 AND user_id = $2", [prodId, ownerId]);
  await addProductionMember(prodId, memberId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("admin 页面入口门：hasEffectiveGrant(permCtx, ...)", () => {
  it("owner 非成员、零 grant 行：admin 各页的键全部放行", async () => {
    const access = await getProductionPermissionContext(ownerId, false, prodId);
    expect(access).not.toBeNull();
    const { permCtx } = access!;
    expect(permCtx.isOwner).toBe(true);
    expect(permCtx.memberPermissions).toBeNull();
    const keys: Array<[string, string, string, "view" | "edit" | "create" | "delete"]> = [
      ["production", "*", "meta/name", "edit"],
      ["member", "*", "contact", "view"],
      ["role", "*", "*", "create"],
      ["dept", "*", "grants", "edit"],
      ["production", "*", "asset_review", "view"],
      ["production", "*", "config", "edit"],
      ["script", "*", "imports", "create"],
      ["production", "*", "archival", "create"],
      ["producer", "*", "*", "view"],
      ["announcement", "*", "*", "create"],
      ["milestone", "*", "*", "edit"],
      ["ai", "*", "usage", "view"],
    ];
    for (const [type, id, sub, verb] of keys) {
      expect(await hasEffectiveGrant(permCtx, prodId, type, id, sub, verb), `${type}/${id}/${sub}@${verb}`).toBe(true);
    }
  });

  it("普通成员只持单枚键：那枚亮、邻键不亮", async () => {
    await getPool().query(
      `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'production', '*', 'asset_review', 'view', 'direct', $2)`,
      [prodId, memberId],
    );
    const access = await getProductionPermissionContext(memberId, false, prodId);
    const { permCtx } = access!;
    expect(permCtx.isOwner).toBe(false);
    expect(await hasEffectiveGrant(permCtx, prodId, "production", "*", "asset_review", "view")).toBe(true);
    expect(await hasEffectiveGrant(permCtx, prodId, "production", "*", "asset_review", "edit")).toBe(false);
    expect(await hasEffectiveGrant(permCtx, prodId, "production", "*", "config", "edit")).toBe(false);
    expect(await hasEffectiveGrant(permCtx, prodId, "member", "*", "contact", "view")).toBe(false);
  });
});
