import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { addProductionMember } from "@/lib/perm/member-db";
import { createMaterial, listMaterialStockLots } from "@/lib/ops/material-db";
import { getMaterialCapabilities } from "@/lib/ops/material-capabilities";
import {
  canManageMaterialDefinition,
  canManageMaterialIdentifiers,
  canManageMaterialSources,
  canRecordMaterialMovement,
} from "@/lib/ops/material-perm";
import { cleanupProduction, makeProduction, shortId } from "../_support/factories";

let productionId: string;
let ownerId: string;
let memberId: string;
let pocId: string;
let deptId: string;
let material: Awaited<ReturnType<typeof createMaterial>>;

const actor = (userId: string) => ({ userId, isAdmin: false, isOwner: false });

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`mat-owner-${shortId()}`, "物料 owner", null, false)).userId;
  memberId = (await upsertFeishuUser(`mat-member-${shortId()}`, "道具成员", null, false)).userId;
  pocId = (await upsertFeishuUser(`mat-poc-${shortId()}`, "道具 POC", null, false)).userId;
  ({ prodId: productionId } = await makeProduction(ownerId));
  await addProductionMember(productionId, memberId);
  await addProductionMember(productionId, pocId);
  const { rows } = await getPool().query<{ id: string }>(
    "INSERT INTO production_dept (production_id,name) VALUES ($1,$2) RETURNING id",
    [productionId, `道具-${shortId()}`],
  );
  deptId = rows[0].id;
  await getPool().query(
    `INSERT INTO production_dept_member (production_id,dept_id,user_id,is_poc)
     VALUES ($1,$2,$3,false),($1,$2,$4,true)`,
    [productionId, deptId, memberId, pocId],
  );
  material = await createMaterial({
    productionId, name: "权限测试道具", subject: { kind: "dept", id: deptId }, createdBy: ownerId,
  });
});

afterAll(async () => { await cleanupProduction(productionId).catch(() => {}); });

describe("物料权限语义", () => {
  it("责任方普通成员能登记日常事实，但不能编辑定义、来源或治理动作", async () => {
    expect(await canRecordMaterialMovement(actor(memberId), productionId, material,
      { operation: "receipt" })).toBe(true);
    expect(await canRecordMaterialMovement(actor(memberId), productionId, material,
      { operation: "checkout", custodianUserId: pocId })).toBe(true);
    expect(await canManageMaterialDefinition(actor(memberId), productionId, material, "edit")).toBe(false);
    expect(await canManageMaterialSources(actor(memberId), productionId, material)).toBe(false);
    expect(await canRecordMaterialMovement(actor(memberId), productionId, material,
      { operation: "adjustment" })).toBe(false);
    expect(await canRecordMaterialMovement(actor(memberId), productionId, material,
      { operation: "exit", returnedToSource: false })).toBe(false);
    expect(await canManageMaterialIdentifiers(actor(memberId), productionId, material.id)).toBe(false);
  });

  it("责任方 POC 管定义和来源，但治理动作仍需显式键", async () => {
    expect(await canManageMaterialDefinition(actor(pocId), productionId, material, "edit")).toBe(true);
    expect(await canManageMaterialSources(actor(pocId), productionId, material)).toBe(true);
    expect(await canRecordMaterialMovement(actor(pocId), productionId, material,
      { operation: "adjustment" })).toBe(false);
    expect(await canManageMaterialIdentifiers(actor(pocId), productionId, material.id)).toBe(false);
  });

  it("任一项目成员只能自助签出、返还自己的和报告自己保管期间的损坏", async () => {
    expect(await canRecordMaterialMovement(actor(memberId), productionId, material,
      { operation: "checkout", custodianUserId: memberId })).toBe(true);
    expect(await canRecordMaterialMovement(actor(memberId), productionId, material,
      { operation: "return", checkoutCustodianUserId: memberId })).toBe(true);
    expect(await canRecordMaterialMovement(actor(memberId), productionId, material,
      { operation: "maintenance", checkoutCustodianUserId: memberId })).toBe(true);
    const unrelated = { ...material, departmentId: null, groupId: null };
    expect(await canRecordMaterialMovement(actor(memberId), productionId, unrelated,
      { operation: "return", checkoutCustodianUserId: pocId })).toBe(false);
  });

  it("批量能力由服务端按全局、责任方、物料和批次返回，归档时统一关闭写面", async () => {
    const [lot] = await listMaterialStockLots(material.id, productionId);
    const open = await getMaterialCapabilities(
      actor(memberId), productionId, false, [material],
    );
    expect(open.representableSubjects).toContainEqual({
      kind: "dept", id: deptId, member: true, poc: false,
    });
    expect(open.byMaterial[material.id]).toMatchObject({
      editDefinition: false, confirmReceipt: true, checkoutSelf: true,
      checkoutForOthers: true, adjustStock: false, exitStock: false,
      manageIdentifiers: false,
    });
    expect(open.byLot[lot.id]).toMatchObject({ checkoutSelf: true, adjustStock: false });
    const archived = await getMaterialCapabilities(
      actor(memberId), productionId, true, [material],
    );
    expect(Object.values(archived.byMaterial[material.id]).every((allowed) => !allowed)).toBe(true);
  });

  it("退还来源方同时要求退出治理与来源管理；POC 获退出键后两条件齐备", async () => {
    await getPool().query(
      `INSERT INTO production_member_grant
        (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source,confirmed_by)
       VALUES ($1,$2,'material','*','stock/exits','edit','direct',$2)`,
      [productionId, pocId],
    );
    expect(await canRecordMaterialMovement(actor(pocId), productionId, material,
      { operation: "exit", returnedToSource: true })).toBe(true);
    expect(await canRecordMaterialMovement(actor(memberId), productionId, material,
      { operation: "exit", returnedToSource: true })).toBe(false);
  });

  it("旧式 sub=* grant 不穿透治理段，显式 identifiers 行才放行", async () => {
    await getPool().query(
      `INSERT INTO production_member_grant
        (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source,confirmed_by)
       VALUES ($1,$2,'material','*','*','edit','direct',$2)`,
      [productionId, memberId],
    );
    expect(await canManageMaterialIdentifiers(actor(memberId), productionId, material.id)).toBe(false);
    await getPool().query(
      `INSERT INTO production_member_grant
        (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source,confirmed_by)
       VALUES ($1,$2,'material','*','identifiers','edit','direct',$2)`,
      [productionId, memberId],
    );
    expect(await canManageMaterialIdentifiers(actor(memberId), productionId, material.id)).toBe(true);
  });
});
