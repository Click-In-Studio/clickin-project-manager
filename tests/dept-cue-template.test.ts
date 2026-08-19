import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCueList, getUserAllowedCueTypes } from "@/lib/db";
import { canCreateViaTemplate, applyCueTemplateGrants, propagateTemplateToExisting,
         removeCueTemplateGrants, instantiateRelKey } from "@/lib/cue-template-db";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// §3.5 Cue 表权限模版体系（2026-08-13 用户设计定稿）
// 场景：音响设计（can_create+全档）建音效表 → 音响执行（view 档声明）自动受益；
// 执行组永远拿不到 create。

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

let prodId: string;
let designDept: string;
let execDept: string;
let designer: string;
let executor: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  [designer, executor] = await Promise.all([newUser(), newUser()]);
  const d1 = await getPool().query<{ id: string }>(
    "INSERT INTO production_dept (production_id, name) VALUES ($1, '音响设计') RETURNING id", [prodId]);
  const d2 = await getPool().query<{ id: string }>(
    "INSERT INTO production_dept (production_id, name) VALUES ($1, '音响部') RETURNING id", [prodId]);
  designDept = d1.rows[0].id;
  execDept = d2.rows[0].id;
  await getPool().query(
    "INSERT INTO production_dept_member (production_id, dept_id, user_id) VALUES ($1,$2,$3),($1,$4,$5)",
    [prodId, designDept, designer, execDept, executor]);
  // 声明：设计=can_create+全档；执行=view 档受益
  await getPool().query(
    `INSERT INTO dept_cue_list_template (production_id, dept_id, template, can_create, permissions) VALUES
     ($1, $2, '音效', true,  ARRAY['@view','@edit','cues@create','cues@delete','grants@edit']),
     ($1, $3, '音效', false, ARRAY['@view'])`,
    [prodId, designDept, execDept]);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("声明表机制", () => {
  it("instantiateRelKey：本体与子面相对键", () => {
    expect(instantiateRelKey("cl1", "@view")).toBe("node:cue_list/cl1@view");
    expect(instantiateRelKey("cl1", "cues@create")).toBe("node:cue_list/cl1/cues@create");
    expect(instantiateRelKey("cl1", "grants@edit")).toBe("node:cue_list/cl1/grants@edit");
  });

  it("can_create 门：设计成员可建、执行成员不可（受益≠建表）", async () => {
    expect(await canCreateViaTemplate(designer, prodId, "音效")).toBe(true);
    expect(await canCreateViaTemplate(executor, prodId, "音效")).toBe(false);
    expect(await getUserAllowedCueTypes(designer, prodId)).toContain("音效");
    expect(await getUserAllowedCueTypes(executor, prodId)).toEqual([]);
  });

  it("建表定式：∀声明部门按各自数组发实例区间键（tension 场景闭环）", async () => {
    const clId = `cl${shortId()}`;
    await createCueList({ id: clId, productionId: prodId, name: "音效表", notes: "",
                          abbr: null, template: "音效", createdBy: designer });
    const { rows } = await getPool().query<{ dept_id: string; permission_key: string }>(
      "SELECT dept_id, permission_key FROM production_dept_permission WHERE production_id = $1 AND permission_key LIKE $2",
      [prodId, `node:cue_list/${clId}%`]);
    const byDept: Record<string, string[]> = {};
    for (const r of rows) (byDept[r.dept_id] ??= []).push(r.permission_key);
    // 设计部门：全档实例键（含 grants@edit）
    expect(byDept[designDept]).toContain(`node:cue_list/${clId}@edit`);
    expect(byDept[designDept]).toContain(`node:cue_list/${clId}/grants@edit`);
    // 执行部门：仅 view——自动受益 ✓ 无 create/edit
    expect(byDept[execDept]).toEqual([`node:cue_list/${clId}@view`]);
    // 归属：can_create 部门（设计）
    const rdm = await getPool().query(
      "SELECT dept_id FROM resource_dept_manage WHERE resource_type='cue_list' AND resource_id=$1", [clId]);
    expect(rdm.rows.map((r: { dept_id: string }) => r.dept_id)).toContain(designDept);

    // #274：这些行不是人在权限中心配的，必须自报家门，否则权限中心会把它们
    // 当人管的平铺出来、并在下次全量替换时删空。
    // 全部是 template 而没有 resource：建表定式发的那四枚（db.ts 的 eligible_depts
    // 路径）与声明数组重叠，而声明通道用 DO UPDATE 升级——**声明是更具体的管家**，
    // 撤声明时那些行本来就会被 removeCueTemplateGrants 按键形收走。
    const src = await getPool().query<{ source: string }>(
      `SELECT DISTINCT source FROM production_dept_permission
       WHERE production_id = $1 AND permission_key LIKE $2`,
      [prodId, `node:cue_list/${clId}%`]);
    expect(src.rows.map(r => r.source).sort()).toEqual(["template"]);
  });

  it("声明变更传播：执行部门升档 → 存量表补键；撤销声明 → 收键", async () => {
    await getPool().query(
      "UPDATE dept_cue_list_template SET permissions = ARRAY['@view','@edit'] WHERE dept_id = $1 AND template = '音效'",
      [execDept]);
    const written = await propagateTemplateToExisting(prodId, execDept, "音效");
    expect(written).toBeGreaterThan(0);
    // 传播补出来的键同样标 template（#274）
    const propagated = await getPool().query<{ source: string }>(
      `SELECT DISTINCT source FROM production_dept_permission
       WHERE dept_id = $1 AND permission_key LIKE 'node:cue_list/%'`, [execDept]);
    expect(propagated.rows).toEqual([{ source: "template" }]);
    const removed = await removeCueTemplateGrants(prodId, execDept, "音效");
    expect(removed).toBeGreaterThan(0);
    const left = await getPool().query(
      "SELECT 1 FROM production_dept_permission WHERE dept_id = $1 AND permission_key LIKE 'node:cue_list/%'",
      [execDept]);
    expect(left.rows).toHaveLength(0);
  });
});
