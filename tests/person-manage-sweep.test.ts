import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember, createCueList } from "@/lib/db";
import { recomputeAndRevokeGrants } from "@/lib/dept-db";
import { getPool } from "@/lib/pg";

// 创建者行集的归属二分（用户模型）：
//   - dept 来源创建（template 匹配创建者所在 dept 的 allowed_cue_types）→ 资源属于 dept，
//     退 dept 后 sweep 收走访问行
//   - role 来源创建（无匹配 dept → person fallback）→ 资源属于个人，
//     dept/role 变动不得影响访问行
// 回归背景：sweep 此前只认 resource_dept_manage 覆盖，person 归属资源
// 在创建者任何 role/dept 变动时被误撤（resource_person_manage 覆盖未被计入）。

let prodId: string;
let userId: string;

async function activeManageRow(cueListId: string): Promise<boolean> {
  // 批A：创建者控制权 = grants@edit 行（manage 单行已拆解为行集）
  const { rows } = await getPool().query(
    `SELECT 1 FROM production_member_grant
     WHERE production_id = $1 AND user_id = $2
       AND resource_type = 'cue_list' AND resource_id = $3
       AND resource_sub = 'grants' AND permission_level = 'edit' AND NOT is_revoked`,
    [prodId, userId, cueListId],
  );
  return rows.length > 0;
}

beforeAll(async () => {
  userId = (await upsertFeishuUser(`test-open-${shortId()}`, `归属甲${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(userId));
  await addProductionMember(prodId, userId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("person 归属（role 来源创建）", () => {
  it("creator's manage row survives dept/role changes", async () => {
    const listId = shortId();
    // 无匹配 dept → person fallback 写 resource_person_manage
    await createCueList({
      id: listId, productionId: prodId, name: "个人表", notes: "",
      abbr: null, template: null, createdBy: userId,
    });
    const { rows: pm } = await getPool().query(
      `SELECT 1 FROM resource_person_manage
       WHERE production_id = $1 AND user_id = $2 AND resource_type = 'cue_list' AND resource_id = $3`,
      [prodId, userId, listId],
    );
    expect(pm.length, "person fallback 应写入 resource_person_manage").toBe(1);
    expect(await activeManageRow(listId)).toBe(true);

    await recomputeAndRevokeGrants(userId, prodId, "dept_change");
    expect(await activeManageRow(listId), "person 归属资源不得被 dept 变动 sweep 撤销").toBe(true);
    await recomputeAndRevokeGrants(userId, prodId, "role_change");
    expect(await activeManageRow(listId), "person 归属资源不得被 role 变动 sweep 撤销").toBe(true);
  });
});

describe("dept 归属（dept 来源创建）", () => {
  it("creator's manage row is swept after leaving the dept", async () => {
    const deptId = (await getPool().query<{ id: string }>(
      `INSERT INTO production_dept (production_id, name)
       VALUES ($1, $2) RETURNING id`,
      [prodId, `音响部${shortId()}`],
    )).rows[0].id;
    // §3.5：归属匹配已改读声明表
    await getPool().query(
      `INSERT INTO dept_cue_list_template (production_id, dept_id, template, can_create, permissions)
       VALUES ($1, $2, 'SQ', true, ARRAY['@view','@edit','cues@create','cues@delete','grants@edit'])
       ON CONFLICT (dept_id, template) DO NOTHING`,
      [prodId, deptId],
    );
    await getPool().query(
      `INSERT INTO production_dept_member (production_id, user_id, dept_id) VALUES ($1, $2, $3)`,
      [prodId, userId, deptId],
    );

    const listId = shortId();
    await createCueList({
      id: listId, productionId: prodId, name: "部门表", notes: "",
      abbr: null, template: "SQ", createdBy: userId,
    });
    const { rows: dm } = await getPool().query(
      `SELECT 1 FROM resource_dept_manage
       WHERE production_id = $1 AND dept_id = $2 AND resource_type = 'cue_list' AND resource_id = $3`,
      [prodId, deptId, listId],
    );
    expect(dm.length, "dept 匹配创建应写入 resource_dept_manage").toBe(1);

    // 仍在 dept：sweep 不撤
    await recomputeAndRevokeGrants(userId, prodId, "dept_change");
    expect(await activeManageRow(listId)).toBe(true);

    // 退 dept：sweep 收走
    await getPool().query(
      `DELETE FROM production_dept_member WHERE production_id = $1 AND user_id = $2 AND dept_id = $3`,
      [prodId, userId, deptId],
    );
    await recomputeAndRevokeGrants(userId, prodId, "dept_change");
    expect(await activeManageRow(listId), "退 dept 后 dept 归属资源的访问行应被收走").toBe(false);
  });
});
