/**
 * GET /api/production/[id]/chats/bindable?q=keyword
 *
 * Search Feishu group chats the bot is in, filtered to:
 *   1. Not a dept group for this production
 *   2. The current user is a member
 *
 * Returns [{ chatId, name }] sorted by name.
 */

import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getProductionDeptChatIds } from "@/lib/event-db";
import { searchChats, getChatMemberOpenIds } from "@/lib/feishu-chat";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q) return Response.json({ chats: [] });

  const [found, deptChatIds] = await Promise.all([
    searchChats(q),
    getProductionDeptChatIds(productionId),
  ]);

  // Filter out dept group chats
  const candidates = found.filter(c => !deptChatIds.has(c.chatId));

  // Filter to only chats the user is in (parallel checks)
  const results = (
    await Promise.all(
      candidates.map(async c => {
        const members = await getChatMemberOpenIds(c.chatId);
        return members.includes(session.openId) ? c : null;
      })
    )
  ).filter(Boolean) as { chatId: string; name: string }[];

  return Response.json({ chats: results });
}
