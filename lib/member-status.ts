/**
 * 成员状态机（#141）——production_member.status 的唯一写点。
 *
 *   active ──成员自助退出──▶ suspended ──持 member 删除门的人──┬──▶ active（复职）
 *                              │                                └──▶ exited（确认离组）
 *                              └── 无人操作 → 一直挂着，零伤害、完全可逆
 *
 * 设计要点（为什么不是「退出审批流」）：
 *
 *   发起即生效。退出不走审批——访问权在成员点下按钮的那一刻就归零了，没有
 *   「待批准」这个中间态。要决定的只是 suspended 往哪个出口走，而那是人事
 *   判定，不是权限判定，所以它没有超时：系统可以催，不该用管理层的沉默替
 *   个人做人事定性（exited 关联结算与署名）。suspended 无限期挂着是可接受
 *   的——访问权已经是零，完全可逆。
 *
 *   suspended 冻结，exited 撤销。suspended 不动 production_member_grant /
 *   production_member_role / production_dept_member 三张表，所以复职是恢复
 *   快照、零重配；exited 才真撤（revokeAllGrantsForMember），于是重新入组
 *   必然是一套新授权，旧权限不会借尸还魂。
 *
 *   异议不是状态。「我不认可他这次退出」不改变任何人能看到什么，它的价值只
 *   在结算与署名争议时作证据 —— 落成 production_member_status_audit 的一条
 *   表态行（to_status IS NULL），不是 status 上的一个值。
 *
 * 谁能推这两个出口：见 lib/member-exit-routing.ts。路由（通知谁）与门（谁能
 * 点）是两件事，此模块只负责写，不做鉴权。
 */

import type { Pool, PoolClient } from "pg";
import { getPool } from "./pg";
import { revokeAllGrantsForMember } from "./dept-db";

export type { MemberStatus, MemberStatusSource } from "./member-status-shared";
import type { MemberStatus, MemberStatusSource } from "./member-status-shared";

/** 改状态的处置动作。表态动作见 MemberStanceAction。 */
export type MemberTransitionAction = "self_exit" | "suspend" | "restore" | "confirm_exit";
/** 不改状态、只留态度的动作。 */
export type MemberStanceAction = "object" | "endorse";

export type MemberStatusRow = {
  status: MemberStatus;
  statusSource: MemberStatusSource | null;
  statusChangedAt: Date | null;
  statusChangedBy: string | null;
};

export async function getMemberStatus(
  productionId: string,
  userId: string,
  db: Pool | PoolClient = getPool(),
): Promise<MemberStatusRow | null> {
  const { rows } = await db.query<{
    status: MemberStatus;
    status_source: MemberStatusSource | null;
    status_changed_at: Date | null;
    status_changed_by: string | null;
  }>(
    `SELECT status, status_source, status_changed_at, status_changed_by::text AS status_changed_by
       FROM production_member WHERE production_id = $1 AND user_id = $2`,
    [productionId, userId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    status: r.status,
    statusSource: r.status_source,
    statusChangedAt: r.status_changed_at,
    statusChangedBy: r.status_changed_by,
  };
}

/**
 * 转换失败的原因。调用方（API）据此选状态码，别把「状态不对」和「没这个人」
 * 混成同一个 404。
 */
export type TransitionFailure = "not_member" | "wrong_status" | "owner_protected";
export type TransitionResult = { ok: true } | { ok: false; reason: TransitionFailure };

/**
 * 一次状态转换 = 一条条件 UPDATE + 一条审计行，同一事务。
 *
 * UPDATE 带 `status = fromStatus` 前置条件，所以并发下第二个请求会打空而不是
 * 覆盖——「两个人同时点确认离组」不会写出两条审计行。
 */
async function transition(
  productionId: string,
  userId: string,
  opts: {
    action: MemberTransitionAction;
    from: MemberStatus;
    to: MemberStatus;
    /** null = 回到 active（跨列不变式要求成因为空）；undefined = 沿用原值 */
    source: MemberStatusSource | null | undefined;
    actorId: string;
    note?: string | null;
    /** 转换成功后、提交前跑，用于 exited 撤权 */
    afterUpdate?: (client: PoolClient) => Promise<void>;
  },
): Promise<TransitionResult> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // owner 不受人事处置：他没有上级，也没人能处置他。owner 要走必须先转移
    // owner（受让方同意），那是另一条路径。
    const { rows: prod } = await client.query<{ owner_id: string | null }>(
      "SELECT owner_id::text AS owner_id FROM production WHERE id = $1",
      [productionId],
    );
    if (prod[0]?.owner_id === userId) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "owner_protected" };
    }

    // source === undefined 表示「沿用原值」（确认离组只定性、不改成因），
    // 此时不占位，直接写回列自身。
    const sourceExpr = opts.source === undefined ? "status_source" : "$6";
    const params: unknown[] = [productionId, userId, opts.to, opts.from, opts.actorId];
    if (opts.source !== undefined) params.push(opts.source);

    const { rows } = await client.query<{ status: string }>(
      `UPDATE production_member
          SET status = $3,
              status_source = ${sourceExpr},
              status_changed_at = NOW(),
              status_changed_by = $5
        WHERE production_id = $1 AND user_id = $2 AND status = $4
        RETURNING status`,
      params,
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      const exists = await getMemberStatus(productionId, userId);
      return { ok: false, reason: exists ? "wrong_status" : "not_member" };
    }

    await client.query(
      `INSERT INTO production_member_status_audit
         (production_id, user_id, action, from_status, to_status, actor_id, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [productionId, userId, opts.action, opts.from, opts.to, opts.actorId, opts.note ?? null],
    );

    await opts.afterUpdate?.(client);

    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** 成员自助退出：active → suspended，成因 self。 */
export async function selfExitMember(
  productionId: string,
  userId: string,
  note?: string | null,
): Promise<TransitionResult> {
  return transition(productionId, userId, {
    action: "self_exit",
    from: "active",
    to: "suspended",
    source: "self",
    actorId: userId,
    note,
  });
}

/** 人事停用：active → suspended，成因 admin。 */
export async function suspendMember(
  productionId: string,
  userId: string,
  actorId: string,
  note?: string | null,
): Promise<TransitionResult> {
  return transition(productionId, userId, {
    action: "suspend",
    from: "active",
    to: "suspended",
    source: "admin",
    actorId,
    note,
  });
}

/**
 * 复职：suspended → active，清空成因。
 *
 * 只受 suspended 一个入口——exited 的人回来不走这里，走邀请（新 membership、
 * 新授权）。这正是「回来是新身份」那条纪律的落点。
 */
export async function restoreMember(
  productionId: string,
  userId: string,
  actorId: string,
  note?: string | null,
): Promise<TransitionResult> {
  return transition(productionId, userId, {
    action: "restore",
    from: "suspended",
    to: "active",
    source: null,
    actorId,
    note,
  });
}

/**
 * 确认离组：suspended → exited，同事务撤销全部授权。
 *
 * 成员行**不删**——署名、工时、审批痕迹、操作记录都要能追溯到这个人。
 * 成因沿用原值（self / admin）：它记的是「他为什么不在职」，确认只是把这件事
 * 定性，不改变当初是谁发起的。
 */
export async function confirmMemberExit(
  productionId: string,
  userId: string,
  actorId: string,
  note?: string | null,
): Promise<TransitionResult> {
  return transition(productionId, userId, {
    action: "confirm_exit",
    from: "suspended",
    to: "exited",
    source: undefined,
    actorId,
    note,
    afterUpdate: (client) => revokeAllGrantsForMember(productionId, userId, client),
  });
}

/**
 * 表态：不认可此退出 / 附议确认他确实走了。
 *
 * 只写审计，不动访问权。链上任何一级都能表态——包括不持 member 门、因而推不动
 * 出口的直属上级，那正是这条路径存在的意义：他最知情，但知情不等于有权。
 */
export async function recordMemberExitStance(
  productionId: string,
  userId: string,
  actorId: string,
  action: MemberStanceAction,
  note?: string | null,
): Promise<TransitionResult> {
  const current = await getMemberStatus(productionId, userId);
  if (!current) return { ok: false, reason: "not_member" };
  if (current.status !== "suspended") return { ok: false, reason: "wrong_status" };

  await getPool().query(
    `INSERT INTO production_member_status_audit
       (production_id, user_id, action, from_status, to_status, actor_id, note)
     VALUES ($1, $2, $3, $4, NULL, $5, $6)`,
    [productionId, userId, action, current.status, actorId, note ?? null],
  );
  return { ok: true };
}

export type MemberStatusAuditRow = {
  id: string;
  action: MemberTransitionAction | MemberStanceAction;
  fromStatus: MemberStatus;
  toStatus: MemberStatus | null;
  actorId: string | null;
  actorName: string | null;
  note: string | null;
  createdAt: Date;
};

/** 某成员的完整状态轨迹（新到旧）。同一个人可以多次进出，故必然是多行。 */
export async function listMemberStatusAudit(
  productionId: string,
  userId: string,
): Promise<MemberStatusAuditRow[]> {
  const { rows } = await getPool().query<{
    id: string;
    action: MemberTransitionAction | MemberStanceAction;
    from_status: MemberStatus;
    to_status: MemberStatus | null;
    actor_id: string | null;
    actor_name: string | null;
    note: string | null;
    created_at: Date;
  }>(
    `SELECT a.id::text AS id, a.action, a.from_status, a.to_status,
            a.actor_id::text AS actor_id, up.name AS actor_name, a.note, a.created_at
       FROM production_member_status_audit a
       LEFT JOIN user_profile up ON up.user_id = a.actor_id
      WHERE a.production_id = $1 AND a.user_id = $2
      ORDER BY a.created_at DESC, a.id DESC`,
    [productionId, userId],
  );
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    actorId: r.actor_id,
    actorName: r.actor_name,
    note: r.note,
    createdAt: r.created_at,
  }));
}

/** 演出内所有 suspended 成员——owner/制作人的「待处理」清单。 */
export async function listSuspendedMembers(
  productionId: string,
): Promise<
  { userId: string; name: string; statusSource: MemberStatusSource | null; since: Date | null }[]
> {
  const { rows } = await getPool().query<{
    user_id: string;
    name: string | null;
    status_source: MemberStatusSource | null;
    status_changed_at: Date | null;
  }>(
    `SELECT pm.user_id::text AS user_id, up.name, pm.status_source, pm.status_changed_at
       FROM production_member pm
       LEFT JOIN user_profile up ON up.user_id = pm.user_id
      WHERE pm.production_id = $1 AND pm.status = 'suspended'
      ORDER BY pm.status_changed_at DESC NULLS LAST`,
    [productionId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name ?? "",
    statusSource: r.status_source,
    since: r.status_changed_at,
  }));
}
