import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { canEnterEvent, hasEventContentEdit } from "@/lib/event-permissions";
import { getProductionEvent } from "@/lib/event-db";
import {
  listRundownColumns, listRundownPlacements, RundownError,
  setRundownColumns, setRundownPlacements,
} from "@/lib/event-rundown-db";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

/**
 * GET — 这个 event 的 rundown 版面：列 + 条目表现。
 *
 * 读门是 canEnterEvent（含通过用户组参与的人）——版面是「谁在什么时候干什么」的
 * 呈现，参与者当然要看得到。
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!await getProductionEvent(eventId, productionId))
    return Response.json({ error: "事件不存在" }, { status: 404 });
  if (!await canEnterEvent(toActor(session, access.permCtx), productionId, eventId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const [columns, placements] = await Promise.all([
    listRundownColumns(eventId),
    listRundownPlacements(eventId),
  ]);
  return Response.json({ columns, placements });
}

/**
 * PUT — 全量覆盖版面。
 *
 * body.columns 与 body.placements 各自独立：只给 columns 就只改列，改个颜色不会
 * 顺带重写整个列布局。两者的门都是 hasEventContentEdit——版面归 organizer，
 * 不是每人一份（原前端塞在 localStorage 里，等于「我的 rundown 不是你的 rundown」）。
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  if (!await hasEventContentEdit(toActor(session, access.permCtx), productionId, eventId, event.status))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as { columns?: unknown; placements?: unknown };

  try {
    if (body.columns !== undefined) {
      if (!Array.isArray(body.columns))
        return Response.json({ error: "columns 必须是数组" }, { status: 400 });
      await setRundownColumns(eventId, productionId, body.columns.map(c => {
        const o = (c ?? {}) as Record<string, unknown>;
        return {
          groupId: typeof o.groupId === "string" ? o.groupId : null,
          matchLocation: typeof o.matchLocation === "string" ? o.matchLocation : null,
          isVisible: o.isVisible === undefined ? true : !!o.isVisible,
          isPinned: !!o.isPinned,
        };
      }));
    }
    if (body.placements !== undefined) {
      if (!Array.isArray(body.placements))
        return Response.json({ error: "placements 必须是数组" }, { status: 400 });
      const parsed: { entryType: "item" | "task"; entryId: string; color?: string | null; pinnedColumnIds?: string[] }[] = [];
      for (const raw of body.placements) {
        const o = (raw ?? {}) as Record<string, unknown>;
        if ((o.entryType !== "item" && o.entryType !== "task") || typeof o.entryId !== "string")
          return Response.json({ error: "placements 项必须含 entryType: 'item'|'task' 与 entryId" }, { status: 400 });
        parsed.push({
          entryType: o.entryType,
          entryId: o.entryId,
          color: typeof o.color === "string" ? o.color : null,
          pinnedColumnIds: Array.isArray(o.pinnedColumnIds)
            ? o.pinnedColumnIds.filter((x): x is string => typeof x === "string")
            : [],
        });
      }
      await setRundownPlacements(eventId, parsed);
    }
  } catch (e) {
    if (e instanceof RundownError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }

  const [columns, placements] = await Promise.all([
    listRundownColumns(eventId),
    listRundownPlacements(eventId),
  ]);
  return Response.json({ columns, placements });
}
