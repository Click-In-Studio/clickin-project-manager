import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import {
  listDeptPermissionRows,
  listDeptPermissionView,
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

/** 读接口现在回 { key, source }（#274）——测试只关心键集时用这个取出来排序。 */
const keysOf = (
  rows: Record<string, { key: string; source: string }[]>,
  deptId: string,
): string[] => (rows[deptId] ?? []).map(r => r.key).sort();

describe("setDeptPermissionRows / listDeptPermissionRows", () => {
  it("全量替换：新增+保留+删除一次完成，重复键去重", async () => {
    await setDeptPermissionRows(prodId, deptId, [
      "node:asset/*@create",
      "node:event/*/meta@view",
    ]);
    let rows = await listDeptPermissionRows(prodId);
    expect(keysOf(rows, deptId)).toEqual(["node:asset/*@create", "node:event/*/meta@view"]);

    await setDeptPermissionRows(prodId, deptId, [
      "node:event/*/meta@view",
      "node:report/*@view",
      "node:report/*@view",
    ]);
    rows = await listDeptPermissionRows(prodId);
    expect(keysOf(rows, deptId)).toEqual(["node:event/*/meta@view", "node:report/*@view"]);
  });

  it("清空：空数组删光该部门行，不影响其他部门", async () => {
    const other = await createProductionDept({ productionId: prodId, name: `旁观部${shortId()}` });
    await setDeptPermissionRows(prodId, other.id, ["node:asset/*@view"]);
    await setDeptPermissionRows(prodId, deptId, []);
    const rows = await listDeptPermissionRows(prodId);
    expect(rows[deptId]).toBeUndefined();
    expect(keysOf(rows, other.id)).toEqual(["node:asset/*@view"]);
  });
});

// ── #274：来源分道 ───────────────────────────────────────────────────────────
//
// 这一组盯的是折叠带来的真正风险：编辑面只提交人管的键，而 setDeptPermissionRows 是
// 全量替换——DELETE 若不限定 source='manual'，在这儿点一下就会把整批实例行删空，
// 且下次传播又补回来，resource_dept_manage 与区间行从此打架。
describe("来源分道（#274）", () => {
  it("管理面全量替换不得删掉声明 / 归属在管的实例行", async () => {
    const pool = getPool();
    const dept = await createProductionDept({ productionId: prodId, name: `分道部${shortId()}` });
    const instanceKey = `node:cue_list/${shortId()}@view`;
    await pool.query(
      `INSERT INTO production_dept_permission (production_id, dept_id, permission_key, source)
       VALUES ($1, $2, $3, 'template')`,
      [prodId, dept.id, instanceKey],
    );
    await setDeptPermissionRows(prodId, dept.id, ["node:asset/*@create"]);

    // 人管的那条按提交内容替换；template 那条一动不动
    const { rows } = await pool.query<{ permission_key: string; source: string }>(
      "SELECT permission_key, source FROM production_dept_permission WHERE dept_id = $1 ORDER BY source",
      [dept.id],
    );
    expect(rows).toEqual([
      { permission_key: "node:asset/*@create", source: "manual" },
      { permission_key: instanceKey, source: "template" },
    ]);

    // 清空人管的行，同样不碰它
    await setDeptPermissionRows(prodId, dept.id, []);
    const after = await pool.query<{ source: string }>(
      "SELECT source FROM production_dept_permission WHERE dept_id = $1", [dept.id]);
    expect(after.rows).toEqual([{ source: "template" }]);
  });

  it("视图按资源实例分组：人管的平铺，别处管的成组", async () => {
    const pool = getPool();
    const dept = await createProductionDept({ productionId: prodId, name: `分组部${shortId()}` });
    const cueA = shortId();
    await pool.query(
      `INSERT INTO production_dept_permission (production_id, dept_id, permission_key, source)
       SELECT $1, $2, k, 'template' FROM unnest($3::text[]) AS k`,
      [prodId, dept.id, [`node:cue_list/${cueA}@view`, `node:cue_list/${cueA}/cues@create`]],
    );
    await pool.query(
      `INSERT INTO production_dept_permission (production_id, dept_id, permission_key, source)
       VALUES ($1, $2, $3, 'resource')`,
      [prodId, dept.id, `node:event/${shortId()}@view`],
    );
    await setDeptPermissionRows(prodId, dept.id, ["node:asset/*@create"]);

    const view = (await listDeptPermissionView(prodId))[dept.id];
    expect(view.manual).toEqual(["node:asset/*@create"]);
    expect(view.groups).toHaveLength(2);
    const cueGroup = view.groups.find(g => g.resourceType === "cue_list")!;
    expect(cueGroup.source).toBe("template");
    expect(cueGroup.keys.sort()).toEqual([`node:cue_list/${cueA}/cues@create`, `node:cue_list/${cueA}@view`].sort());
    // 查不到名字的实例回落显示 id（资源已删、行等 sweep 的情况）
    expect(cueGroup.label).toBe(cueA);
    expect(view.groups.find(g => g.resourceType === "event")!.source).toBe("resource");
  });

  it("非 manual 但键形没有具体实例的行，落回人管那栏（不制造无出口的行）", async () => {
    const pool = getPool();
    const dept = await createProductionDept({ productionId: prodId, name: `兜底部${shortId()}` });
    await pool.query(
      `INSERT INTO production_dept_permission (production_id, dept_id, permission_key, source)
       VALUES ($1, $2, 'node:asset/*@create', 'resource')`,
      [prodId, dept.id],
    );
    const view = (await listDeptPermissionView(prodId))[dept.id];
    expect(view.manual).toEqual(["node:asset/*@create"]);
    expect(view.groups).toEqual([]);
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

describe("isGovernanceNodeKey（治理键=SENSITIVE/ROOT 手写清单，非 type 前缀）", () => {
  it("production 基线面不是治理键；grants/asset_review/integrations 整面是", async () => {
    const { isGovernanceNodeKey } = await import("@/lib/grant-template");
    expect(isGovernanceNodeKey("node:production/*/meta@view")).toBe(false);
    expect(isGovernanceNodeKey("node:production/*/mounts@view")).toBe(false);
    expect(isGovernanceNodeKey("node:production/*/config@edit")).toBe(false);
    expect(isGovernanceNodeKey("node:production/*/meta/name@edit")).toBe(true);
    expect(isGovernanceNodeKey("node:production/*/grants@view")).toBe(true);
    expect(isGovernanceNodeKey("node:production/*/asset_review@view")).toBe(true);
    expect(isGovernanceNodeKey("node:production/*/integrations@view")).toBe(true);
    expect(isGovernanceNodeKey("node:production/*@delete")).toBe(true);
    expect(isGovernanceNodeKey("node:producer/*@view")).toBe(true);
  });

  it("通配键不误杀（RESERVED_TYPES 不被通配覆盖）；非法键=null", async () => {
    const { isGovernanceNodeKey } = await import("@/lib/grant-template");
    expect(isGovernanceNodeKey("node:*/*@*")).toBe(false);
    // 资源级 grants 段（如 cue 表协作者管理）非治理清单——治理性只看手写三态
    expect(isGovernanceNodeKey("node:event/*/grants@*")).toBe(false);
    expect(isGovernanceNodeKey("node:event/*/meta@*")).toBe(false);
    expect(isGovernanceNodeKey("not-a-key")).toBe(null);
  });
});
