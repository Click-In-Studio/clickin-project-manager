import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember, createCueList } from "@/lib/db";
import {
  addCueListDeptAccess, removeCueListDeptAccess,
  checkCueListFreeApprovalZone, selfConfirmCueListGrant,
} from "@/lib/resource-grant-db";
import { recomputeAndRevokeGrants } from "@/lib/dept-db";
import { getPool } from "@/lib/pg";

// dept 分享 = 归属（rdm）+ zone 资格（dept_permission 实例行集）：
//   授予 → 成员进入第 3 步免审批区间 → 自确认落 grant；
//   撤销 → 资格行删除 + 成员存续立即重算（不等下次 role/dept 变动）。
// 另回归：成员基础通配行由 role 区间键保护，sweep 不误撤（四路覆盖之③）。

let prodId: string;
let ownerId: string;
let memberId: string;
let deptId: string;
let listId: string;

async function activeRows(userId: string, resourceId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
    `SELECT resource_sub, permission_level FROM production_member_grant
     WHERE production_id = $1 AND user_id = $2
       AND resource_type = 'cue_list' AND resource_id = $3 AND NOT is_revoked`,
    [prodId, userId, resourceId],
  );
  return rows.map((r) => `${r.resource_sub}@${r.permission_level}`).sort();
}

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `分享甲${shortId()}`, null, false)).userId;
  memberId = (await upsertFeishuUser(`test-open-${shortId()}`, `分享乙${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  await addProductionMember(prodId, ownerId);
  await addProductionMember(prodId, memberId);

  deptId = (await getPool().query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id`,
    [prodId, `分享部${shortId()}`],
  )).rows[0].id;
  await getPool().query(
    `INSERT INTO production_dept_member (production_id, user_id, dept_id) VALUES ($1, $2, $3)`,
    [prodId, memberId, deptId],
  );

  listId = shortId();
  await createCueList({
    id: listId, productionId: prodId, name: "被分享的表", notes: "",
    abbr: null, template: null, createdBy: ownerId,
  });
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("dept 分享（zone + grant）", () => {
  it("share grants zone eligibility; member self-confirms into row-set", async () => {
    // 分享前：不在区间
    expect(await checkCueListFreeApprovalZone(memberId, prodId, listId, "edit")).toBe(false);

    await addCueListDeptAccess(listId, prodId, deptId, ownerId);
    // zone 资格行已写
    expect(await checkCueListFreeApprovalZone(memberId, prodId, listId, "edit")).toBe(true);

    // 自确认 → 动词行集落地
    await selfConfirmCueListGrant(memberId, prodId, listId, "edit");
    expect(await activeRows(memberId, listId)).toEqual(
      ["*@view", "*@edit", "cues@create", "cues@delete"].sort(),
    );
  });

  it("unshare removes zone rows and immediately sweeps confirmed grants", async () => {
    await removeCueListDeptAccess(listId, prodId, deptId);
    expect(await checkCueListFreeApprovalZone(memberId, prodId, listId, "edit")).toBe(false);
    // 存续立即重算：资格消失 → 行收走
    expect(await activeRows(memberId, listId)).toEqual([]);
  });
});

describe("四路覆盖之③：zone 键保护成员基础行", () => {
  it("member-base wildcard rows survive recompute while role keys still grant them", async () => {
    // 给成员一个持有成员基础节点键的角色（迁移后的真实形态）
    const roleId = `role_share_${shortId()}`;
    await getPool().query(
      "INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, $3)",
      [roleId, prodId, `基础角色${shortId()}`],
    );
    await getPool().query(
      `INSERT INTO production_role_permission (role_id, permission_key)
       VALUES ($1, 'node:cue_list/*/meta@view'), ($1, 'node:cue_list/*/cues@view')`,
      [roleId],
    );
    await getPool().query(
      "INSERT INTO production_member_role (production_id, user_id, role_id) VALUES ($1, $2, $3)",
      [prodId, memberId, roleId],
    );
    // 成员基础通配行（激活面自确认的产物）
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'cue_list', '*', 'meta', 'view', 'self_confirmed', $2),
              ($1, $2, 'cue_list', '*', 'cues', 'view', 'self_confirmed', $2)`,
      [prodId, memberId],
    );

    // 任意变动触发 sweep：role 区间键仍授予 → 行存续（修复前会被误撤）
    await recomputeAndRevokeGrants(memberId, prodId, "dept_change");
    expect(await activeRows(memberId, "*")).toEqual(["cues@view", "meta@view"].sort());

    // 摘掉角色 → 资格消失 → 行收走
    await getPool().query(
      "DELETE FROM production_member_role WHERE production_id = $1 AND user_id = $2 AND role_id = $3",
      [prodId, memberId, roleId],
    );
    await recomputeAndRevokeGrants(memberId, prodId, "role_change");
    expect(await activeRows(memberId, "*")).toEqual([]);
  });
});
