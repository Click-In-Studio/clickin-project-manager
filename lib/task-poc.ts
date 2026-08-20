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
 * 单值语义是硬约束——POC 必须是责任单点，不能是集合，否则「指派归 POC」
 * （2026-08-15 定谳）没有唯一答案。用户组是多一个 **kind**（组自带 POC，
 * 见 event_group），不是让 task 同时挂多个主体：DB 的 task_subject_single
 * CHECK 保证 department_id / group_id 至多一个非空。
 */
export type TaskSubject =
  | { kind: "dept"; id: string }
  | { kind: "group"; id: string };

/**
 * 从 task 行取责任主体；无主体（独立任务未绑部门也未绑组）返回 null。
 *
 * 两者互斥由 DB 的 task_subject_single CHECK 保证，这里按 dept 优先只是防御性写法
 * ——真出现两个都非空说明 CHECK 被绕过了，那是更严重的问题。
 */
export function taskSubjectOf(
  task: { departmentId: string | null; groupId?: string | null },
): TaskSubject | null {
  if (task.departmentId) return { kind: "dept", id: task.departmentId };
  if (task.groupId) return { kind: "group", id: task.groupId };
  return null;
}

/**
 * 组 POC：解析到「组当前定义」——user 型就是那个人，dept 型是该部门的**现任** POC。
 *
 * 与 isDeptPoc 一样是活引用（Type B）：部门换 POC、组改 POC，下一次判定自动跟随，
 * 不需要回溯改任何行。production 作用域同样并进条件里。
 */
async function isGroupPocScoped(productionId: string, groupId: string, userId: string): Promise<boolean> {
  const res = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM event_group eg
        WHERE eg.id = $2 AND eg.production_id = $1
          AND (eg.poc_user_id = $3
               OR EXISTS (SELECT 1 FROM production_dept_member pdm
                           WHERE pdm.dept_id = eg.poc_dept_id
                             AND pdm.user_id = $3 AND pdm.is_poc = true))
     ) AS exists`,
    [productionId, groupId, userId],
  );
  return res.rows[0].exists;
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

/**
 * 候选责任主体的 POC 判定（task 尚未创建时用）。主体为 null 恒 false。
 *
 * `eventId` 是**冻结语境**：组主体 + 该 event 已对这个组冻结 → POC 读快照里那位，
 * 不读组的现任 POC。这是「POC 在冻结后分裂」的落实——追责认当时那个人，而且
 * **权限不自动漂移**：他失效了也不会自动换人，要动这条 task 得有人显式接手
 * （owner 旁路或申请通道）。谁来接手是 PSM 的判断，机器不做这个决定。
 */
export async function isSubjectPoc(
  productionId: string,
  subject: TaskSubject | null,
  userId: string,
  eventId?: string | null,
): Promise<boolean> {
  if (!subject) return false;
  switch (subject.kind) {
    case "dept":
      return isDeptPoc(productionId, subject.id, userId);
    case "group": {
      if (eventId) {
        const { isGroupFrozenForEvent, frozenGroupPocUserIds } = await import("./event-group-freeze");
        if (await isGroupFrozenForEvent(eventId, subject.id)) {
          return (await frozenGroupPocUserIds(eventId, subject.id)).includes(userId);
        }
      }
      return isGroupPocScoped(productionId, subject.id, userId);
    }
  }
}

/**
 * 已存在 task 的 POC 判定。
 *
 * 带上 task.eventId 一起传下去——组主体在已冻结的 event 里要读快照 POC（见
 * {@link isSubjectPoc}）。传 task 整个对象而不是拆字段，就是为了不让调用点漏掉它。
 */
export function isTaskPoc(
  productionId: string,
  task: { departmentId: string | null; groupId?: string | null; eventId?: string | null },
  userId: string,
): Promise<boolean> {
  return isSubjectPoc(productionId, taskSubjectOf(task), userId, task.eventId ?? null);
}

/** 便捷形式：调用点手里只有一个 groupId 字符串时用。 */
export function isGroupSubjectPoc(
  productionId: string,
  groupId: string | null,
  userId: string,
): Promise<boolean> {
  return isSubjectPoc(productionId, groupId ? { kind: "group", id: groupId } : null, userId);
}

/** 便捷形式：调用点手里只有一个 deptId 字符串时用，省去自己包 subject。 */
export function isDeptSubjectPoc(
  productionId: string,
  deptId: string | null,
  userId: string,
): Promise<boolean> {
  return isSubjectPoc(productionId, deptId ? { kind: "dept", id: deptId } : null, userId);
}

// ─── 请求体 → 责任主体 ────────────────────────────────────────────────────────

export type SubjectParse =
  | { ok: true; subject: TaskSubject | null }
  | { ok: false; status: 400; error: string };

/** 校验一个候选主体属于本 production；不属于则回 400 文案。 */
async function checkInProduction(
  productionId: string,
  subject: TaskSubject,
): Promise<string | null> {
  const table = subject.kind === "dept" ? "production_dept" : "event_group";
  const { rows } = await getPool().query(
    `SELECT 1 FROM ${table} WHERE id = $1 AND production_id = $2`,   // ddl-check-ignore
    [subject.id, productionId],
  );
  if (rows.length) return null;
  return subject.kind === "dept" ? "部门不存在" : "用户组不存在";
}

/**
 * 从请求体解析责任主体（**创建**用）。
 *
 * 四个 task 写入口都要做同一件事，抄四遍就会漂——尤其「跨剧组 id 不能骗过 POC
 * 各门」这条防线，收敛前已经在 tasks/route.ts 的注释里被点过一次名。
 *
 * 两者互斥在这里就拒（DB 的 task_subject_single CHECK 是兜底，不是主门）——
 * 让用户看到 400「二选一」，而不是一条约束违反的 500。
 */
export async function parseTaskSubject(
  productionId: string,
  body: { departmentId?: unknown; groupId?: unknown },
): Promise<SubjectParse> {
  const hasDept  = typeof body.departmentId === "string" && body.departmentId !== "";
  const hasGroup = typeof body.groupId === "string" && body.groupId !== "";
  if (hasDept && hasGroup)
    return { ok: false, status: 400, error: "责任主体只能二选一：部门或用户组" };

  const subject: TaskSubject | null =
    hasDept  ? { kind: "dept",  id: body.departmentId as string }
    : hasGroup ? { kind: "group", id: body.groupId as string }
    : null;
  if (subject) {
    const err = await checkInProduction(productionId, subject);
    if (err) return { ok: false, status: 400, error: err };
  }
  return { ok: true, subject };
}

export type SubjectPatch =
  | { ok: true; cols: { departmentId: string | null; groupId: string | null } | null }
  | { ok: false; status: 400; error: string };

/**
 * 从请求体解析责任主体的**改动**（PATCH 用）。与创建版的关键差别：
 *
 * **每个字段只清它自己那一支。** `departmentId: null` 只意味着「没有负责部门」，
 * 不碰用户组；要解绑组得显式发 `groupId: null`。
 *
 * 这条不是洁癖，是修一个真实的数据丢失：任务抽屉初始化时做
 * `setDrawerDeptId(task.departmentId ?? "")`，绑组的 task 这里是空串，提交时就发
 * `departmentId: null`。若按「给了 departmentId 就重设整个主体」处理，任何人在抽屉里
 * 点一下保存——哪怕一个字没改——都会把组绑定清掉，POC 随之消失，这条 task 谁都
 * 编辑不了了。旧客户端不知道有组这回事，不能让它们的沉默变成删除。
 *
 * 返回 `cols: null` 表示这次请求不涉及主体，调用方不要动那两列。
 */
export async function resolveSubjectPatch(
  productionId: string,
  body: { departmentId?: unknown; groupId?: unknown },
  current: { departmentId: string | null; groupId?: string | null },
): Promise<SubjectPatch> {
  const deptGiven  = body.departmentId !== undefined;
  const groupGiven = body.groupId !== undefined;
  if (!deptGiven && !groupGiven) return { ok: true, cols: null };

  const nextDept  = typeof body.departmentId === "string" && body.departmentId !== ""
    ? body.departmentId : null;
  const nextGroup = typeof body.groupId === "string" && body.groupId !== ""
    ? body.groupId : null;
  if (nextDept && nextGroup)
    return { ok: false, status: 400, error: "责任主体只能二选一：部门或用户组" };

  // 设了一支 ⇒ 另一支被顶掉（互斥）；只清一支 ⇒ 另一支原样保留
  let departmentId = current.departmentId;
  let groupId = current.groupId ?? null;
  if (nextDept)        { departmentId = nextDept; groupId = null; }
  else if (nextGroup)  { groupId = nextGroup; departmentId = null; }
  else {
    if (deptGiven)  departmentId = null;
    if (groupGiven) groupId = null;
  }

  const subject = departmentId ? { kind: "dept" as const, id: departmentId }
    : groupId ? { kind: "group" as const, id: groupId } : null;
  // 只校验这次新指定的那个——原样保留的那支本来就在库里
  if (subject && ((nextDept && subject.kind === "dept") || (nextGroup && subject.kind === "group"))) {
    const err = await checkInProduction(productionId, subject);
    if (err) return { ok: false, status: 400, error: err };
  }
  return { ok: true, cols: { departmentId, groupId } };
}

/** 把主体摊回 task 的两列（创建入口用）。 */
export function subjectColumns(subject: TaskSubject | null): {
  departmentId: string | null; groupId: string | null;
} {
  return {
    departmentId: subject?.kind === "dept"  ? subject.id : null,
    groupId:      subject?.kind === "group" ? subject.id : null,
  };
}
