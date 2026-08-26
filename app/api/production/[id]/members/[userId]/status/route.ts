/**
 * 成员状态机端点（#141）。
 *
 * 动词形而不是赋值形：POST { action } 而不是 PATCH { status }。退出、停用、复职、
 * 确认离组是四个语义不同的动作，各自的门也不同（自助退出只要「是本人」，其余三个
 * 要 member 删除门）。写成赋值形就得在服务端从 (旧值,新值) 反推是谁在干什么——
 * 而 active → suspended 既可能是自助退出也可能是人事停用，反推不出来。
 *
 * GET 返回当前状态 + 完整轨迹（退出进度查询）。
 */

import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { MAX_APPROVAL_COMMENT_LENGTH } from "@/lib/approval-stages";
import { getProductionPermissionContext, isProductionArchived } from "@/lib/db";
import { getPool } from "@/lib/pg";
import {
  selfExitMember,
  suspendMember,
  restoreMember,
  confirmMemberExit,
  recordMemberExitStance,
  getMemberStatus,
  listMemberStatusAudit,
  type TransitionResult,
} from "@/lib/member-status";
import { canHandleMemberExit, resolveExitHandlers } from "@/lib/member-exit-routing";
import { notifyMemberExitPending, notifyMemberStatusChanged } from "@/lib/notify";

const ACTIONS = ["self_exit", "suspend", "restore", "confirm_exit", "object", "endorse"] as const;
type Action = (typeof ACTIONS)[number];

/**
 * note 会进审计轨迹、并被推给链上所有人，所以它是**用户可见的持久文本**，
 * 按审批意见同一把尺子校验（AI review #3）。类型标注挡不住运行时的任意 JSON。
 */
function parseNote(raw: unknown): { ok: true; note: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, note: null };
  if (typeof raw !== "string") return { ok: false, error: "note 必须是字符串" };
  if (raw.length > MAX_APPROVAL_COMMENT_LENGTH) {
    return { ok: false, error: `说明不能超过 ${MAX_APPROVAL_COMMENT_LENGTH} 字` };
  }
  const trimmed = raw.trim();
  return { ok: true, note: trimmed === "" ? null : trimmed };
}

/**
 * 通知是尽力而为（AI review #2）。状态转换此刻已经提交，若通知这一步抛错就返回
 * 500，客户端会重试并撞上 wrong_status——一次其实成功了的操作，对用户显示为失败
 * 且无法重来。通知失败该记日志，不该翻转已成事实的结果。
 */
async function bestEffortNotify(what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    console.error(`[member-status] ${what} 通知失败（状态已变更，不影响结果）:`, e);
  }
}

/** 转换失败 → HTTP。别把「状态不对」和「没这个人」混成同一个码。 */
function failureResponse(res: Extract<TransitionResult, { ok: false }>): Response {
  switch (res.reason) {
    case "not_member":
      return Response.json({ error: "该用户不是本项目成员" }, { status: 404 });
    case "owner_protected":
      return Response.json(
        { error: "项目 Owner 不受成员处置；要退出请先转移 Owner" },
        { status: 409 },
      );
    case "wrong_status":
      return Response.json({ error: "当前成员状态不允许该操作" }, { status: 409 });
  }
}

async function getProductionName(productionId: string): Promise<string> {
  const { rows } = await getPool().query<{ name: string }>(
    "SELECT name FROM production WHERE id = $1",
    [productionId],
  );
  return rows[0]?.name ?? "";
}

async function getUserName(userId: string): Promise<string> {
  const { rows } = await getPool().query<{ name: string | null; display_name: string | null }>(
    "SELECT name, display_name FROM user_profile WHERE user_id = $1",
    [userId],
  );
  return rows[0]?.display_name || rows[0]?.name || "";
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; userId: string }> },
) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id, userId } = await ctx.params;

  const isSelf = session.userId === userId;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  // 退出的人自己看不到 permission context（闸门已经关了），所以 isSelf 单独放行。
  if (!isSelf && !access) return Response.json({ error: "权限不足" }, { status: 403 });

  // 轨迹里带着退出说明与人事处置理由，不是「在职成员皆可见」的东西（AI review #1）。
  // 可见范围与「谁被通知」一致：本人、持处置门的人、处置链上的人。
  if (!isSelf) {
    const canHandle = access ? await canHandleMemberExit(access.permCtx, id) : false;
    const onLadder = canHandle
      ? true
      : (await resolveExitHandlers(id, userId)).some((h) => h.userId === session.userId);
    if (!onLadder) return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const status = await getMemberStatus(id, userId);
  if (!status) return Response.json({ error: "该用户不是本项目成员" }, { status: 404 });

  return Response.json({ status, audit: await listMemberStatusAudit(id, userId) });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; userId: string }> },
) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id, userId } = await ctx.params;
  if (await isProductionArchived(id)) {
    return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  }

  const { action, note: rawNote } = (await req.json()) as { action?: string; note?: unknown };
  if (!action || !(ACTIONS as readonly string[]).includes(action)) {
    return Response.json({ error: "action 非法" }, { status: 400 });
  }
  const act = action as Action;

  const parsedNote = parseNote(rawNote);
  if (!parsedNote.ok) return Response.json({ error: parsedNote.error }, { status: 400 });
  const note = parsedNote.note;

  const isSelf = session.userId === userId;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);

  // ── 自助退出：只要「是本人且当前在职」，不需要任何 member 门 ────────────────
  if (act === "self_exit") {
    if (!isSelf) return Response.json({ error: "只能为自己发起退出" }, { status: 403 });
    if (!access) return Response.json({ error: "你不是本项目的在职成员" }, { status: 403 });

    const res = await selfExitMember(id, userId, note);
    if (!res.ok) return failureResponse(res);

    await bestEffortNotify("self_exit", async () => {
      const [prodName, subjectName, handlers] = await Promise.all([
        getProductionName(id),
        getUserName(userId),
        resolveExitHandlers(id, userId),
      ]);
      await notifyMemberExitPending({
        productionId: id,
        productionName: prodName,
        subjectUserId: userId,
        subjectName,
        source: "self",
        handlers,
        note,
      });
    });
    return Response.json({ ok: true });
  }

  if (!access) return Response.json({ error: "权限不足" }, { status: 403 });
  const permCtx = access.permCtx;

  // ── 表态：链上任何一级都能留态度，不需要门 ─────────────────────────────────
  // 不持 member 门的直属上级正是这条路径的主要用户：他最知情，但知情不等于有权。
  if (act === "object" || act === "endorse") {
    const handlers = await resolveExitHandlers(id, userId);
    const onLadder = handlers.some((h) => h.userId === session.userId);
    if (!onLadder && !(await canHandleMemberExit(permCtx, id))) {
      return Response.json({ error: "你不在该成员的处置链上" }, { status: 403 });
    }
    const res = await recordMemberExitStance(id, userId, session.userId, act, note);
    if (!res.ok) return failureResponse(res);
    return Response.json({ ok: true });
  }

  // ── 处置：停用 / 复职 / 确认离组，统一走 member 删除门 ─────────────────────
  // 两个方向共用一个门是刻意的：能停用的人本来就能复职，按方向分门守不住，
  // 只会变成两套要同步的规则。方向的区分交给 status_source 与审计行承担。
  if (!(await canHandleMemberExit(permCtx, id))) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }
  if (isSelf) {
    return Response.json({ error: "不能对自己执行成员处置" }, { status: 403 });
  }

  // 显式 switch + never 穷尽（AI review #4）：三元链会把任何未匹配的 action 悄悄
  // 落到 confirm_exit——将来往 ACTIONS 里加一枚而忘了这里，后果是静默撤销授权。
  let res;
  switch (act) {
    case "suspend":
      res = await suspendMember(id, userId, session.userId, note);
      break;
    case "restore":
      res = await restoreMember(id, userId, session.userId, note);
      break;
    case "confirm_exit":
      res = await confirmMemberExit(id, userId, session.userId, note);
      break;
    default: {
      const exhaustive: never = act;
      return Response.json({ error: `未处理的 action: ${exhaustive}` }, { status: 400 });
    }
  }
  if (!res.ok) return failureResponse(res);

  await bestEffortNotify(act, async () => {
    const prodName = await getProductionName(id);
    await notifyMemberStatusChanged({
      productionId: id,
      productionName: prodName,
      userId,
      action: act,
      note,
    });

    // 人事停用同样要通知链上——「有人不在职了，等你处置」与自助退出是同一件事，
    // 只是成因不同。区别只在文案。
    if (act === "suspend") {
      const [subjectName, handlers] = await Promise.all([
        getUserName(userId),
        resolveExitHandlers(id, userId),
      ]);
      await notifyMemberExitPending({
        productionId: id,
        productionName: prodName,
        subjectUserId: userId,
        subjectName,
        source: "admin",
        handlers: handlers.filter((h) => h.userId !== session.userId),
        note,
      });
    }
  });

  return Response.json({ ok: true });
}
