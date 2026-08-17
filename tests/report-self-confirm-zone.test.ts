/**
 * 报告自我确认的免审批区间（2026-08-17 回归）+ 死列棘轮。
 *
 * 事故：报告自确认路由的 POST 用 checkResourceFreeApprovalZone 判 edit 档，
 * 那个函数的 dept 分支查 `pd.permissions` 数组 + 伪键 'report:edit'——伪键随批C
 * 清零、数组列随 PR #229 并表批 DROP，函数却留在原地。GET 侧的 getReportAccess
 * 早已改走 checkNodeFreeApprovalZone，于是「页面说你可以自我确认，点下去 500」。
 * manage 档不碰那列，所以线上表现是时好时坏而非全挂——最难查的那种。
 *
 * 本文件两层：
 *   ① 功能层：区间判定的四种命中/不命中（实例键 / 通配键 / POC / 什么都没有）
 *   ② 棘轮层：源码里不得再出现已 DROP 的列名——同类死代码不会再活到线上
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { getPool } from "@/lib/pg";
import { checkNodeFreeApprovalZone } from "@/lib/resource-grant-db";
import { createProductionDept, setDeptMembers, addResourceDeptManage } from "@/lib/dept-db";
import { makeProduction, cleanupProduction, shortId } from "./factories";

const TEST_USER = "00000000-0000-0000-0000-000000000001";
const USER_ZONE = "00000000-0000-0000-0000-000000000020";  // 经 dept 区间键拿资格
const USER_POC  = "00000000-0000-0000-0000-000000000021";  // 经管理 dept 的 POC 拿资格
const USER_NONE = "00000000-0000-0000-0000-000000000022";  // 什么都没有
const USER_WILD = "00000000-0000-0000-0000-000000000023";  // 经通配区间键拿资格

let prodId: string;
const reportId = shortId();   // 区间判定与报告本体无关（不 join 报告表），合成 id 即可
let zoneDeptId: string;
let pocDeptId: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_user (id, created_at) VALUES ($1, NOW()), ($2, NOW()), ($3, NOW()), ($4, NOW())
     ON CONFLICT DO NOTHING`,
    [USER_ZONE, USER_POC, USER_NONE, USER_WILD],
  );

  const zoneDept = await createProductionDept({ productionId: prodId, name: `zone-${shortId()}` });
  const pocDept  = await createProductionDept({ productionId: prodId, name: `poc-${shortId()}` });
  zoneDeptId = zoneDept.id;
  pocDeptId  = pocDept.id;

  await setDeptMembers(zoneDeptId, prodId, [{ userId: USER_ZONE, isPoc: false }]);
  await setDeptMembers(pocDeptId,  prodId, [{ userId: USER_POC,  isPoc: true  }]);

  // zone dept：实例级区间键（六步链第 3 步的资格源）
  await pool.query(
    `INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
     VALUES ($1, $2, $3) ON CONFLICT (dept_id, permission_key) DO NOTHING`,
    [prodId, zoneDeptId, `node:report/${reportId}@edit`],
  );
  // poc dept：归属（rdm）——manage 档只认管理部门的 POC
  await addResourceDeptManage({
    productionId: prodId, deptId: pocDeptId,
    resourceType: "report", resourceId: reportId, establishedBy: TEST_USER,
  });
});

afterAll(async () => {
  await getPool()
    .query("DELETE FROM app_user WHERE id = ANY($1)", [[USER_ZONE, USER_POC, USER_NONE, USER_WILD]])
    .catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("报告 edit/manage 档免审批区间", () => {
  it("dept 持实例区间键 → edit 档在区间内（旧实现在这一步 500）", async () => {
    expect(await checkNodeFreeApprovalZone(USER_ZONE, prodId, "report", reportId, "edit")).toBe(true);
  });

  it("dept 区间键不给 manage 档（manage 只认管理部门的 POC）", async () => {
    expect(await checkNodeFreeApprovalZone(USER_ZONE, prodId, "report", reportId, "manage")).toBe(false);
  });

  it("管理部门的 POC → manage 与 edit 两档都在区间内", async () => {
    expect(await checkNodeFreeApprovalZone(USER_POC, prodId, "report", reportId, "manage")).toBe(true);
    expect(await checkNodeFreeApprovalZone(USER_POC, prodId, "report", reportId, "edit")).toBe(true);
  });

  it("无区间键、非 POC → 两档都不在区间内（走申请流）", async () => {
    expect(await checkNodeFreeApprovalZone(USER_NONE, prodId, "report", reportId, "edit")).toBe(false);
    expect(await checkNodeFreeApprovalZone(USER_NONE, prodId, "report", reportId, "manage")).toBe(false);
  });

  it("通配区间键 node:report/*@edit 同样命中该实例", async () => {
    const wildDept = await createProductionDept({ productionId: prodId, name: `wild-${shortId()}` });
    await setDeptMembers(wildDept.id, prodId, [{ userId: USER_WILD, isPoc: false }]);
    await getPool().query(
      `INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
       VALUES ($1, $2, 'node:report/*@edit') ON CONFLICT (dept_id, permission_key) DO NOTHING`,
      [prodId, wildDept.id],
    );
    expect(await checkNodeFreeApprovalZone(USER_WILD, prodId, "report", reportId, "edit")).toBe(true);
  });
});

// ── 棘轮：源码不得再查询已 DROP 的列 ──────────────────────────────────────────

/** PR #229 并表批 DROP 的列（判定机制已由区间行 / 声明表接管）。 */
const DROPPED_COLUMNS: readonly string[] = [
  "pd.permissions",
  "production_dept.permissions",
  "allowed_cue_types",
  "poc_extra_permissions",
  "poc_blocked_permissions",
];

function collectSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      out.push({ path: full, text: readFileSync(full, "utf8") });
    }
  };
  for (const dir of ["app", "lib"]) walk(dir);
  return out;
}

describe("死列棘轮", () => {
  it("app/ 与 lib/ 不再引用已 DROP 的部门数组列", () => {
    const hits: string[] = [];
    for (const { path, text } of collectSources()) {
      for (const line of text.split("\n")) {
        // 注释里可以提这些名字（迁移记录、退役说明），只禁真正的查询
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        for (const col of DROPPED_COLUMNS) {
          if (line.includes(col)) hits.push(`${path}: ${line.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
