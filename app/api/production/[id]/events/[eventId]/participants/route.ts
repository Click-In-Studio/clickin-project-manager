import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getProductionEvent, listEventParticipants, setEventParticipants } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  const participants = await listEventParticipants(eventId);
  return Response.json({ participants });
}

/**
 * PUT — replace the full participant list.
 * Body: { participants: { userId: string; name: string; departmentId: string | null; role: "participant" | "follower" }[] }
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("event:assign_people", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  const body = (await req.json()) as { participants?: unknown };
  const validRoles = new Set(["participant", "follower"]);
  if (
    !Array.isArray(body.participants) ||
    body.participants.some(
      (x) =>
        typeof x !== "object" || x === null ||
        typeof (x as Record<string, unknown>).userId !== "string" ||
        typeof (x as Record<string, unknown>).name !== "string" ||
        !validRoles.has((x as Record<string, unknown>).role as string)
    )
  ) {
    return Response.json(
      { error: "participants 必须是 { userId, name, departmentId?, role }[]" },
      { status: 400 }
    );
  }

  const participants = body.participants as {
    userId: string; name: string; departmentId: string | null; role: "participant" | "follower";
  }[];
  await setEventParticipants(eventId, participants);

  const updated = await listEventParticipants(eventId);
  return Response.json({ participants: updated });
}
