import { type NextRequest } from "next/server";
import { hasEventDomainView } from "@/lib/event-permissions";
import { toActor, hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName, getBossOpenIds } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import {
  listProductionDepts,
  createProductionDept,
  getProductionDept,
  setDeptChatId,
} from "@/lib/dept-db";
import { createChat } from "@/lib/platform/feishu/feishu-chat";

type Ctx = { params: Promise<{ id: string }> };

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, access: null };
  const access = await getProductionPermissionContext(
    session.userId, session.isAdmin, productionId
  );
  return { session, access };
}

/** GET — list all departments for a production. Requires any member. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { session, access } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!(await hasEventDomainView(toActor(session, permCtx), id)))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const departments = await listProductionDepts(id);
  return Response.json({ departments });
}

/** POST — create a department. Requires dept:create. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { session, access } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!(permCtx.isAdmin || await hasGrant(permCtx.userId, id, "org_dept", "*", "*", "create")))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    name?: string;
    parentId?: string | null;
    displayOrder?: number;
    permissions?: string[];
    allowedCueTypes?: string[];
  };

  const name = body.name?.trim();
  if (!name) return Response.json({ error: "名称不能为空" }, { status: 400 });

  const displayOrder = typeof body.displayOrder === "number" ? body.displayOrder : 0;

  const dept = await createProductionDept({
    productionId: id,
    name,
    parentId: body.parentId ?? null,
    displayOrder,
    permissions: body.permissions ?? [],
    allowedCueTypes: body.allowedCueTypes ?? [],
  });

  // Auto-create Feishu group for new dept
  try {
    const [productionName, bossIds] = await Promise.all([
      getProductionName(id),
      getBossOpenIds(id),
    ]);
    const chatName = `${productionName ?? "项目"} - ${name}`;
    const memberIds = [...new Set([session.userId, ...bossIds])];
    const chatId = await createChat(chatName, session.userId, memberIds, "only_owner_and_administrator");
    if (chatId) await setDeptChatId(dept.id, chatId);
  } catch (e) {
    console.error("[dept/chat] auto-create failed:", e);
  }

  const updated = await getProductionDept(dept.id, id);
  return Response.json({ department: updated ?? dept }, { status: 201 });
}
