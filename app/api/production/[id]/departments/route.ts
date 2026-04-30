import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getProductionName, getBossOpenIds } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import {
  listEventDepartments,
  createEventDepartment,
  getEventDepartment,
  setDepartmentChatId,
} from "@/lib/event-db";
import { createChat } from "@/lib/feishu-chat";

type Ctx = { params: Promise<{ id: string }> };

let _seq = 0;
const uid = () => `dept${Date.now().toString(36)}${(++_seq).toString(36)}`;

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map(), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(
    session.openId, session.isAdmin, productionId
  );
  return { session, memberRoles, overrides, isArchived };
}

/** GET — list all departments and groups for a production. Requires any member. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const departments = await listEventDepartments(id);
  return Response.json({ departments });
}

/** POST — create a department or group. Requires dept:manage. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("dept:manage", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    name?: string;
    kind?: string;
    displayOrder?: number;
  };

  const name = body.name?.trim();
  if (!name) return Response.json({ error: "名称不能为空" }, { status: 400 });

  const kind = body.kind === "group" ? "group" : "dept";
  const displayOrder = typeof body.displayOrder === "number" ? body.displayOrder : 0;

  const dept = await createEventDepartment({
    id: uid(),
    productionId: id,
    name,
    kind,
    displayOrder,
  });

  // Auto-create Feishu group for dept
  if (kind === "dept") {
    try {
      const [productionName, bossIds] = await Promise.all([
        getProductionName(id),
        getBossOpenIds(id),
      ]);
      const chatName = `${productionName ?? "项目"} - ${name}`;
      const memberIds = [...new Set([session.openId, ...bossIds])];
      const chatId = await createChat(chatName, session.openId, memberIds, "only_owner_and_administrator");
      if (chatId) await setDepartmentChatId(dept.id, chatId);
    } catch (e) {
      console.error("[dept/chat] auto-create failed:", e);
    }
  }

  const updated = await getEventDepartment(dept.id, id);
  return Response.json({ department: updated ?? dept }, { status: 201 });
}
