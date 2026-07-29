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

    // Execute all effects in one transaction.
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const effect of action.effects) {
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
      const ALLOWED_STATUS: Record<string, { table: string; column: string }> = {
        tech_req: { table: "event_tech_req", column: "status" },
      };
      const meta = ALLOWED_STATUS[effect.entityType];
      if (!meta) throw new Error(`Unknown entityType for set_status: ${effect.entityType}`);
      await client.query(
        `UPDATE ${meta.table} SET ${meta.column} = $1 WHERE id = $2`,
        [effect.to, effect.entityId],
      );
      break;
    }

    case "set_choice": {
      // Stores the user's choice value on the entity. The specific column depends
      // on the entity type; extend this map as new choice-bearing types are added.
      const ALLOWED_CHOICE: Record<string, { table: string; column: string; ownerColumn?: string }> = {
        tech_req: { table: "event_tech_req", column: "assignee_response", ownerColumn: undefined },
      };
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

    default:
      // Exhaustiveness guard — unknown effect types are ignored, not thrown, so
      // new effect types can be deployed without breaking existing notifications.
      console.warn("[notifications/act] unknown effect type:", (effect as { type: string }).type);
  }
}
