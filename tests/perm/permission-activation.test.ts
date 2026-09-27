import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { activatePendingPermissions } from "@/lib/perm/permission-activation-db";
import { addProductionMember } from "@/lib/perm/member-db";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { cleanupProduction, makeProduction, shortId } from "../_support/factories";

let prodId: string;
let memberId: string;
let outsiderId: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  memberId = (await upsertFeishuUser(`test-open-${shortId()}`, `待激活${shortId()}`, null, false)).userId;
  outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `局外人${shortId()}`, null, false)).userId;
  await addProductionMember(prodId, memberId);
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
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("权限激活共享落行入口", () => {
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
});
