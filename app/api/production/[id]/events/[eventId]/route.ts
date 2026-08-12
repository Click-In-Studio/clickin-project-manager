import { type NextRequest } from "next/server";
import { hasAnyEffectiveGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getVersion } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { getProductionEvent, updateProductionEvent, deleteProductionEvent, setEventStageManagers, completeAllEventTechReqs } from "@/lib/event-db";
import { maybeSendLatePublishDailyCall, dispatchEventPublishNotifications } from "@/lib/notify";
import { hasResourceGrantLevel } from "@/lib/resource-grant-db";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

async function validateVersion(productionId: string, versionId?: string | null) {
  if (!versionId) return true;
  const version = await getVersion(versionId);
  return version?.productionId === productionId;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!(await hasAnyEffectiveGrant({ userId: session.userId, isAdmin: permCtx.isAdmin, isOwner: permCtx.isOwner }, productionId, "event", ["meta", "details"], "view")))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  return Response.json({ event });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const existing = await getProductionEvent(eventId, productionId);
  if (!existing) return Response.json({ error: "事件不存在" }, { status: 404 });

  const body = (await req.json()) as {
    title?: string; eventType?: string; location?: string;
    startTime?: string | null; endTime?: string | null;
    status?: string; description?: string;
    stageManagers?: { userId: string; name: string }[];
    versionId?: string | null;
  };

  // Determine required grant level from the requested operation:
  //   published→field edit = edit_published; →cancelled/completed = revoke
  //   draft→published = publish; all other draft edits = edit
  const newStatus = body.status;
  let requiredLevel: "edit" | "publish" | "edit_published" | "revoke" = "edit";
  if (existing.status === "published") {
    requiredLevel = newStatus === "cancelled" || newStatus === "completed" ? "revoke" : "edit_published";
  } else if (newStatus === "published") {
    requiredLevel = "publish";
  }

  if (!permCtx.isAdmin && !await hasResourceGrantLevel(session.userId, productionId, "event", eventId, requiredLevel))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const validStatuses = new Set(["draft", "published", "completed", "cancelled"]);
  if (body.status && !validStatuses.has(body.status))
    return Response.json({ error: "无效的状态值" }, { status: 400 });
  if ("versionId" in body && !(await validateVersion(productionId, body.versionId))) {
    return Response.json({ error: "版本不存在" }, { status: 404 });
  }

  await updateProductionEvent(eventId, productionId, {
    title: body.title?.trim(),
    eventType: body.eventType,
    location: body.location,
    startTime: body.startTime,
    endTime: body.endTime,
    status: body.status as Parameters<typeof updateProductionEvent>[2]["status"],
    description: body.description,
    ...("versionId" in body ? { versionId: body.versionId } : {}),
  });
  if (body.status === "completed") {
    await completeAllEventTechReqs(eventId);
  }
  if (body.status === "published" && existing.status !== "published") {
    // Always send event_publish RSVP notifications to call_time recipients.
    void dispatchEventPublishNotifications(eventId).catch((e: unknown) =>
      console.error("[notify] event-publish notifications error:", e),
    );
    // If published late in the day (past noon CST) and event is tomorrow,
    // also send daily-call confirmations.
    void maybeSendLatePublishDailyCall(eventId).catch((e: unknown) =>
      console.error("[notify] late-publish daily call error:", e),
    );
  }
  if (body.stageManagers !== undefined) {
    await setEventStageManagers(eventId, body.stageManagers);
  }
  const updated = await getProductionEvent(eventId, productionId);

  return Response.json({ event: updated });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const existing = await getProductionEvent(eventId, productionId);
  if (!existing) return Response.json({ error: "事件不存在" }, { status: 404 });

  if (!permCtx.isAdmin && !await hasResourceGrantLevel(session.userId, productionId, "event", eventId, "manage"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  await deleteProductionEvent(eventId, productionId);
  return Response.json({ ok: true });
}
