import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import {
  listDeptPermissionRows,
  setDeptPermissionRows,
  getPermissionVocabulary,
} from "@/lib/perm-center-db";
import { createProductionDept } from "@/lib/dept-db";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// 管理后台·权限中心数据层：部门权限行全量替换（多退少补）+ 词汇聚合

let prodId: string;
let deptId: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  const dept = await createProductionDept({ productionId: prodId, name: `权限部${shortId()}` });
  deptId = dept.id;
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("setDeptPermissionRows / listDeptPermissionRows", () => {
  it("全量替换：新增+保留+删除一次完成，重复键去重", async () => {
    await setDeptPermissionRows(prodId, deptId, [
      "node:asset/*@create",
      "node:event/*/meta@view",
    ]);
    let rows = await listDeptPermissionRows(prodId);
    expect(rows[deptId]?.sort()).toEqual(["node:asset/*@create", "node:event/*/meta@view"]);

    await setDeptPermissionRows(prodId, deptId, [
      "node:event/*/meta@view",
      "node:report/*@view",
      "node:report/*@view",
    ]);
    rows = await listDeptPermissionRows(prodId);
    expect(rows[deptId]?.sort()).toEqual(["node:event/*/meta@view", "node:report/*@view"]);
  });

  it("清空：空数组删光该部门行，不影响其他部门", async () => {
    const other = await createProductionDept({ productionId: prodId, name: `旁观部${shortId()}` });
    await setDeptPermissionRows(prodId, other.id, ["node:asset/*@view"]);
    await setDeptPermissionRows(prodId, deptId, []);
    const rows = await listDeptPermissionRows(prodId);
    expect(rows[deptId]).toBeUndefined();
    expect(rows[other.id]).toEqual(["node:asset/*@view"]);
  });
});

describe("getPermissionVocabulary", () => {
  it("动词来自 resource_permission_level 闭集；在用 sub 进入提示面", async () => {
    await setDeptPermissionRows(prodId, deptId, ["node:event/*/call_sheet@view"]);
    const vocab = await getPermissionVocabulary(prodId);
    expect(vocab.verbs.event).toEqual(expect.arrayContaining(["view", "create", "edit", "delete"]));
    expect(vocab.verbs.role).toBeDefined();
    expect(vocab.subs.event).toEqual(expect.arrayContaining(["call_sheet"]));
  });
});
