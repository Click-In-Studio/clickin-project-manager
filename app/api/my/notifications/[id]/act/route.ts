/**
 * POST /api/my/notifications/:id/act
 *
 * Execute an inline action on a notification.
 *
 * Body: { actionId: string; value?: unknown }
 *
 * The endpoint:
 *  1. Loads the notification and verifies ownership.
 *  2. Finds the matching action by actionId.
 *  3. Executes each effect in the action in a single DB transaction.
 *  4. Marks the notification as acted (+ read if not already).
 */

import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getUserNotification, markNotificationActed, rsvpCallTime } from "@/lib/inbox-db";
import { approveAccessRequest, escalateAccessRequest, rejectAccessRequest } from "@/lib/db";
import { getPool } from "@/lib/pg";
import type { ActionEffect } from "@/lib/inbox-db";
import type { PoolClient } from "pg";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    actionId?: string;
    value?: unknown;
  };
  if (!body.actionId) return Response.json({ error: "缺少 actionId" }, { status: 400 });

  const notif = await getUserNotification(id, session.userId);
  if (!notif) return Response.json({ error: "通知不存在" }, { status: 404 });

  // "external" is a sentinel: no inline actions to execute, just mark as acted.
  if (body.actionId !== "external") {
    const action = notif.actions.find((a) => a.id === body.actionId);
    if (!action) return Response.json({ error: "动作不存在" }, { status: 400 });

    // Self-managed effects (approve/reject access requests) manage their own
    // transactions internally. Run them outside the pool-client transaction so
    // there is no false expectation that a ROLLBACK on client would undo them.
    const SELF_MANAGED_EFFECTS = [
      "approve_access_request", "reject_access_request", "escalate_access_request",
    ] as const;
    const isSelfManaged = (e: ActionEffect) =>
      (SELF_MANAGED_EFFECTS as readonly string[]).includes(e.type);
    const selfManaged = action.effects.filter(isSelfManaged);
    const transactional = action.effects.filter((e) => !isSelfManaged(e));

    // Invariant: an action must not mix multiple self-managed effects, because
    // partial failure (second throws after first committed) has no rollback path.
    if (selfManaged.length > 1) {
      console.error("[notifications/act] action has >1 self-managed effects — refusing", action.id);
      return Response.json({ error: "操作配置错误" }, { status: 500 });
    }

    // Run self-managed effect first (atomic on its own connection).
    for (const effect of selfManaged) {
      await executeSelfManagedEffect(effect, session.userId);
    }

    // Run remaining effects in a single transaction.
    if (transactional.length > 0) {
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const effect of transactional) {
          await executeEffect(client, effect, session.userId, body.value);
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        console.error("[notifications/act] transaction failed:", e);
        return Response.json({ error: "操作失败" }, { status: 500 });
      } finally {
        client.release();
      }
    }
  }

  // Record the acted state on the notification (outside the transaction above —
  // this is a best-effort audit trail; failure here doesn't undo the action).
  await markNotificationActed(id, session.userId, body.actionId, body.value).catch((e) => {
    console.error("[notifications/act] markNotificationActed failed:", e);
  });

  return Response.json({ ok: true });
}

async function executeEffect(
  client: PoolClient,
  effect: ActionEffect,
  userId: string,
  value: unknown,
): Promise<void> {
  switch (effect.type) {
    case "set_field": {
      // Only fields explicitly permitted here can be written — no open injection.
      const ALLOWED: Record<string, Record<string, string>> = {
        call_time: { confirmed_at: "event_call_time" },
      };
      const tableMap = ALLOWED[effect.entityType];
      if (!tableMap) throw new Error(`Unknown entityType: ${effect.entityType}`);
      const table = tableMap[effect.field];
      if (!table) throw new Error(`Disallowed field: ${effect.field}`);
      await client.query(
        `UPDATE ${table} SET ${effect.field} = now()
         WHERE id = $1 AND user_id = $2`,
        [effect.entityId, userId],
      );
      break;
    }

    case "set_status": {
      const ALLOWED_STATUS: Record<string, { table: string; column: string; values: string[] }> = {
        tech_req: { table: "task", column: "status", values: ["awaiting", "pending", "in_progress", "done", "cancelled"] },
      };
      const meta = ALLOWED_STATUS[effect.entityType];
      if (!meta) throw new Error(`Unknown entityType for set_status: ${effect.entityType}`);
      if (!meta.values.includes(effect.to)) throw new Error(`Disallowed status value: ${effect.to}`);
      await client.query(
        `UPDATE ${meta.table} SET ${meta.column} = $1 WHERE id = $2`,
        [effect.to, effect.entityId],
      );
      break;
    }

    case "set_choice": {
      // Stores the user's choice value on the entity. The specific column depends
      // on the entity type; extend this map as new choice-bearing types are added.
      // （tech_req 曾在此规划 assignee_response 回执——2026-08-15 定谳指派通知
      //   为纯告知不设回执，且该列从未建；映射已移除防触发即 SQL 报错）
      const ALLOWED_CHOICE: Record<string, { table: string; column: string; ownerColumn?: string }> = {};
      const meta = ALLOWED_CHOICE[effect.entityType];
      if (!meta) throw new Error(`Unknown entityType for set_choice: ${effect.entityType}`);
      const ownerClause = meta.ownerColumn ? ` AND ${meta.ownerColumn} = $3` : "";
      await client.query(
        `UPDATE ${meta.table} SET ${meta.column} = $1 WHERE id = $2${ownerClause}`,
        meta.ownerColumn
          ? [String(value), effect.entityId, userId]
          : [String(value), effect.entityId],
      );
      break;
    }

    case "set_rsvp": {
      // Soft RSVP (是/否/待定) on a call_time row before the dispatch window.
      // The rsvp value comes from the effect definition (not user-supplied value)
      // so it cannot be spoofed — only the predefined label matters.
      await client.query(
        `UPDATE event_call_time
         SET rsvp = $1, rsvp_at = now()
         WHERE id = $2 AND user_id = $3`,
        [effect.rsvp, effect.entityId, userId],
      );
      break;
    }

    case "mark_read":
      await client.query(
        `UPDATE user_notification SET read_at = now()
         WHERE entity_type = $1 AND entity_id = $2 AND user_id = $3 AND read_at IS NULL`,
        [effect.entityType ?? "", effect.entityId ?? "", userId],
      );
      break;

    case "mark_acted":
      // Handled outside the transaction via markNotificationActed; no-op here.
      break;

    case "approve_access_request":
    case "reject_access_request":
    case "escalate_access_request":
      // Handled by executeSelfManagedEffect — should not reach here.
      break;

    default:
      // Exhaustiveness guard — unknown effect types are ignored, not thrown, so
      // new effect types can be deployed without breaking existing notifications.
      console.warn("[notifications/act] unknown effect type:", (effect as { type: string }).type);
  }
}

async function executeSelfManagedEffect(
  effect: ActionEffect,
  userId: string,
): Promise<void> {
  switch (effect.type) {
    case "approve_access_request": {
      const result = await approveAccessRequest(effect.requestId, userId);
      if (!result.ok) {
        if (result.reason === "unauthorized") throw new Error("无权审批");
        if (result.reason === "forward_only") throw new Error("你尚未持有该权限，只能向上转交给下一级审批人");
        if (result.reason === "not_found") {
          // Stale notification with a bad requestId — log but don't surface to user.
          console.warn("[notifications/act] approve_access_request: requestId not found", effect.requestId);
        }
        // conflict = someone else got there first; swallow silently.
      }
      break;
    }
    case "reject_access_request": {
      const result = await rejectAccessRequest(effect.requestId, userId);
      if (!result.ok) {
        if (result.reason === "unauthorized") throw new Error("无权审批");
        if (result.reason === "not_found") {
          console.warn("[notifications/act] reject_access_request: requestId not found", effect.requestId);
        }
      }
      break;
    }
    case "escalate_access_request": {
      // #140：无权终局的直属上级把申请推给阶梯下一级
      const result = await escalateAccessRequest(effect.requestId, userId);
      if (!result.ok) {
        if (result.reason === "unauthorized") throw new Error("无权处理此申请");
        if (result.reason === "no_next_stage") throw new Error("已到审批链顶端，无法继续转发");
        if (result.reason === "not_found") {
          console.warn("[notifications/act] escalate_access_request: requestId not found", effect.requestId);
        }
        // conflict = 已被他人处理或已升级；静默吞掉
      }
      break;
    }
    default:
      break;
  }
}
