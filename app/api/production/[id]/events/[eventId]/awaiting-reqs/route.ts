import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getProductionEvent, upsertAwaitingTechReqs } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (!hasPermission("event:schedule_edit", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  const body = (await req.json()) as { departmentIds?: string[]; scheduleItemId?: string };
  const departmentIds = body.departmentIds ?? [];
  if (!departmentIds.length) return Response.json({ techReqs: [] });

  const techReqs = await upsertAwaitingTechReqs(eventId, departmentIds, body.scheduleItemId);
  return Response.json({ techReqs });
}
