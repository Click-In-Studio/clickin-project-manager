import { type NextRequest } from "next/server";
import { hasEventDomainView } from "@/lib/event-permissions";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getVersion } from "@/lib/db";
import { getProductionEvent, updateProductionEvent, deleteProductionEvent, setEventStageManagers, completeAllEventTechReqs } from "@/lib/event-db";
import { maybeSendLatePublishDailyCall, dispatchEventPublishNotifications } from "@/lib/notify";

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
  if (!(await hasEventDomainView(toActor(session, permCtx), productionId)))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  if (event.status !== "published" && event.status !== "completed") {
    const canSeeDraft = await hasEffectiveGrant(toActor(session, permCtx), productionId, "event", eventId, "publication", "view");
    if (!canSeeDraft) return Response.json({ error: "无权访问" }, { status: 403 });
  }
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

  const REQ_NODE: Record<string, [string, string]> = {
    edit: ["details", "edit"], publish: ["publication", "create"],
    edit_published: ["publication", "edit"], revoke: ["publication", "delete"],
  };
  const [reqSub, reqVerb] = REQ_NODE[requiredLevel];
  if (!await hasEffectiveGrant(toActor(session, permCtx), productionId, "event", eventId, reqSub, reqVerb as "view" | "create" | "edit" | "delete"))
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
    await setEventStageManagers(eventId, body.stageManagers, productionId, session.userId);
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

  // #236 张力 4a：本门此前查 `grants@edit`（授权权），使 `event/<id>/*@delete` 成为
  // 死动词，并造出一条违反 M-2 的隐式蕴含「能转授 ⟹ 能删」。改查 delete 动词后与
  // 其余 17 条 DELETE 路由一致。默认持钥人＝制作人（node:*/*@* 全集）；创建者要不要
  // 有，由策略键 event.creator:*@delete 决定（默认关，松的剧组可打开）。
  if (!await hasEffectiveGrant(toActor(session, permCtx), productionId, "event", eventId, "*", "delete"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  await deleteProductionEvent(eventId, productionId);
  return Response.json({ ok: true });
}
