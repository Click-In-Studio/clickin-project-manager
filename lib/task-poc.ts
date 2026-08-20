/**
 * task 责任主体 → POC 判定的唯一入口。
 *
 * ## 为什么要收敛
 *
 * 「task 关联部门的 POC 恒可编辑内容并推进状态」这条用户规范，原来在 4 个 lib 函数
 * + 7 个路由分支里各抄了一遍 `x.departmentId && isUserDeptPoc(x.departmentId, uid)`，
 * 十一处口径全靠人肉保持一致。责任主体一旦从「部门」扩成「部门 | 用户组」，十一个点
 * 各改一遍必然漏——漏掉的那个点不会报错，只会静默地少认一类 POC（或多认一类）。
 *
 * 所以先把它们收成本文件的两个入口：
 *   - {@link isTaskPoc}    —— 判一条**已存在的 task**
 *   - {@link isSubjectPoc} —— 判一个**候选责任主体**（task 尚未创建时，如 POST 的 body.departmentId）
 *
 * 扩展责任主体类型时只改 {@link TaskSubject} 与 {@link isSubjectPoc}，调用点不动。
 * `tests/task-poc-converge.test.ts` 的静态棘轮会挡住绕过本文件直接调
 * `isUserDeptPoc` 的新代码。
 *
 * ## 判定性质
 *
 * 仍是 Type B 上下文关系判定——不落 grant 行，部门后关联 / POC 变更自动跟踪，
 * 无需行同步（同 lib/event-permissions.ts 的既有口径）。
 *
 * ## 与原实现的一处收紧
 *
 * 原 `isUserDeptPoc(deptId, userId)` **不限 production**，各路由靠先跑一次
 * `getEventDepartment(deptId, productionId)` 自保；漏跑就会被跨剧组的部门 id
 * 骗过 POC 各门（`app/api/production/[id]/tasks/route.ts` 的注释点过这个名）。
 * 本文件把 production 并进判定条件，让它不再依赖调用方的自觉。各路由原有的
 * 部门存在性校验保留——它还负责回 400「部门不存在」这个更准的错。
 */

import { getPool } from "./pg";

/**
 * task 的责任主体：谁为这条 task 负责，POC 从它推导。
 *
 * 单值语义是硬约束——POC 必须是责任单点，不能是集合，否则
 * 「指派归 POC」（2026-08-15 定谳）没有唯一答案。用户组进来后是
 * 多一个 kind（组自带 POC），不是让 task 同时挂多个主体。
 */
export type TaskSubject =
  | { kind: "dept"; id: string };
  // 用户组落地后在此追加：| { kind: "group"; id: string }

/** 从 task 行取责任主体；无主体（独立任务未绑部门）返回 null。 */
export function taskSubjectOf(task: { departmentId: string | null }): TaskSubject | null {
  return task.departmentId ? { kind: "dept", id: task.departmentId } : null;
}

async function isDeptPoc(productionId: string, deptId: string, userId: string): Promise<boolean> {
  const res = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM production_dept_member
       WHERE production_id = $1 AND dept_id = $2 AND user_id = $3 AND is_poc = true
     ) AS exists`,
    [productionId, deptId, userId],
  );
  return res.rows[0].exists;
}

/** 候选责任主体的 POC 判定（task 尚未创建时用）。主体为 null 恒 false。 */
export async function isSubjectPoc(
  productionId: string,
  subject: TaskSubject | null,
  userId: string,
): Promise<boolean> {
  if (!subject) return false;
  switch (subject.kind) {
    case "dept":
      return isDeptPoc(productionId, subject.id, userId);
  }
}

/** 已存在 task 的 POC 判定。 */
export function isTaskPoc(
  productionId: string,
  task: { departmentId: string | null },
  userId: string,
): Promise<boolean> {
  return isSubjectPoc(productionId, taskSubjectOf(task), userId);
}

/** 便捷形式：调用点手里只有一个 deptId 字符串时用，省去自己包 subject。 */
export function isDeptSubjectPoc(
  productionId: string,
  deptId: string | null,
  userId: string,
): Promise<boolean> {
  return isSubjectPoc(productionId, deptId ? { kind: "dept", id: deptId } : null, userId);
}
