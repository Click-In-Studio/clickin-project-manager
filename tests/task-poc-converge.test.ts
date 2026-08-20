/**
 * task POC 判定的收敛棘轮。
 *
 * 「task 责任主体的 POC 恒可编辑内容并推进状态」这条用户规范，收敛前散在 4 个 lib
 * 函数 + 7 个路由分支里各抄一遍。责任主体从「部门」扩成「部门 | 用户组」时，十一处
 * 各改一遍必然漏，而漏掉的点不会报错——只会静默地少认（或多认）一类 POC。
 *
 * 两层：
 *  1. 静态棘轮 —— 除 lib/task-poc.ts 与定义处外，lib/ 与 app/api/ 不得直调 isUserDeptPoc
 *  2. 行为验证 —— 收敛入口的判定口径，含收敛时新加的 production 作用域
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdir, readFile } from "fs/promises";
import path from "path";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { isTaskPoc, isSubjectPoc, isDeptSubjectPoc, taskSubjectOf } from "@/lib/task-poc";

// ─────────────────────────────────────────────────────────────────────────────
// 1. 静态棘轮：不许绕过收敛入口
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(process.cwd());
const SCAN_DIRS = ["lib", "app/api"];

/**
 * 允许直调 isUserDeptPoc 的文件。
 *
 * 往这里加条目前先问一句：这个判定真的与 task 责任主体无关吗？若有关，要走
 * lib/task-poc.ts，否则用户组落地后它会成为唯一一个只认部门不认组的门。
 */
const ALLOWED = new Set([
  "lib/event-db.ts",   // 定义处（部门 POC 这个原语本身）
  "lib/task-poc.ts",   // 唯一消费者
]);

async function listTs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && !["node_modules", ".next", ".git"].includes(e.name)) {
      out.push(...await listTs(full));
    } else if (e.isFile() && e.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("task POC 判定收敛棘轮", () => {
  it("lib/ 与 app/api/ 不得绕过 lib/task-poc.ts 直调 isUserDeptPoc", async () => {
    const files: string[] = [];
    for (const dir of SCAN_DIRS) files.push(...await listTs(path.join(ROOT, dir)));

    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      if (ALLOWED.has(rel)) continue;
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return; // 注释不算
        if (/\bisUserDeptPoc\s*\(/.test(line)) violations.push(`${rel}:${i + 1}  ${t}`);
      });
    }

    expect(
      violations,
      `以下位置绕过了 lib/task-poc.ts 直接判部门 POC。\n` +
      `task 责任主体的 POC 判定必须走 isTaskPoc / isSubjectPoc / isDeptSubjectPoc，\n` +
      `否则用户组落地后这些点只认部门不认组：\n  ${violations.join("\n  ")}`,
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 行为验证
// ─────────────────────────────────────────────────────────────────────────────

let prodId: string;
let otherProdId: string;
let ownerId: string;
let pocId: string;
let memberId: string;
let deptId: string;

beforeAll(async () => {
  ownerId  = (await upsertFeishuUser(`test-open-${shortId()}`, `收敛甲${shortId()}`, null, false)).userId;
  pocId    = (await upsertFeishuUser(`test-open-${shortId()}`, `收敛POC${shortId()}`, null, false)).userId;
  memberId = (await upsertFeishuUser(`test-open-${shortId()}`, `收敛成员${shortId()}`, null, false)).userId;

  ({ prodId } = await makeProduction(ownerId));
  ({ prodId: otherProdId } = await makeProduction(ownerId));
  for (const u of [pocId, memberId]) await addProductionMember(prodId, u);

  ({ rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id`,
    [prodId, `收敛部门${shortId()}`],
  ));
  await getPool().query(
    `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc)
     VALUES ($1, $2, $3, true), ($1, $2, $4, false)`,
    [prodId, deptId, pocId, memberId],
  );
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await cleanupProduction(otherProdId).catch(() => {});
});

describe("taskSubjectOf", () => {
  it("有部门 → dept 主体；无部门 → null（独立任务无责任主体）", () => {
    expect(taskSubjectOf({ departmentId: "d1" })).toEqual({ kind: "dept", id: "d1" });
    expect(taskSubjectOf({ departmentId: null })).toBeNull();
  });
});

describe("isTaskPoc / isSubjectPoc", () => {
  it("部门 POC 判 true，普通部门成员判 false", async () => {
    expect(await isTaskPoc(prodId, { departmentId: deptId }, pocId)).toBe(true);
    expect(await isTaskPoc(prodId, { departmentId: deptId }, memberId)).toBe(false);
  });

  it("无责任主体的 task 恒 false（不因为没主体就放行）", async () => {
    expect(await isTaskPoc(prodId, { departmentId: null }, pocId)).toBe(false);
    expect(await isSubjectPoc(prodId, null, pocId)).toBe(false);
  });

  it("production 作用域：拿本剧组部门 id 去别的剧组问，判 false", async () => {
    // 收敛前 isUserDeptPoc(deptId, uid) 不看 production，各路由靠自己先跑
    // getEventDepartment 自保；漏跑就会被跨剧组部门 id 骗过 POC 各门。
    // 作用域并进判定后，这条防线不再依赖调用方的自觉。
    expect(await isDeptSubjectPoc(prodId, deptId, pocId)).toBe(true);
    expect(await isDeptSubjectPoc(otherProdId, deptId, pocId)).toBe(false);
  });
});
