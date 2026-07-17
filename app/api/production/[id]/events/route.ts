import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getVersion } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { listProductionEvents, createProductionEvent } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string }> };

let _seq = 0;
const uid = () => `ev${Date.now().toString(36)}${(++_seq).toString(36)}`;

async function validateVersion(productionId: string, versionId?: string | null) {
  if (!versionId) return true;
  const version = await getVersion(versionId);
  return version?.productionId === productionId;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const events = await listProductionEvents(productionId);
  return Response.json({ events });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("event:create", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    title?: string; eventType?: string; location?: string;
    startTime?: string | null; endTime?: string | null; description?: string;
    versionId?: string | null;
  };
  const title = body.title?.trim();
  if (!title) return Response.json({ error: "标题不能为空" }, { status: 400 });
  if (!(await validateVersion(productionId, body.versionId))) {
    return Response.json({ error: "版本不存在" }, { status: 404 });
  }

  const event = await createProductionEvent({
    id: uid(),
    productionId,
    title,
    eventType: body.eventType ?? "custom",
    location: body.location ?? "",
    startTime: body.startTime ?? null,
    endTime: body.endTime ?? null,
    description: body.description ?? "",
    createdBy: session.openId,
    versionId: body.versionId ?? null,
  });
  return Response.json({ event }, { status: 201 });
}
