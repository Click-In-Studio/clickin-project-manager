import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { acceptInvite } from "@/lib/invite-db";

// POST — 接受邀请（登录后）。校验与入组在 acceptInvite 事务内。
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return Response.json({ error: "邀请无效" }, { status: 400 });
  }
  const result = await acceptInvite(token, session.userId);
  if (!result.ok) {
    const msg = {
      not_found: "邀请不存在",
      revoked: "邀请已被撤销",
      expired: "邀请已过期",
      exhausted: "邀请使用次数已用完",
      email_mismatch: "该邀请为定向邀请，与当前登录邮箱不符",
    }[result.reason];
    return Response.json({ error: msg }, { status: result.reason === "not_found" ? 404 : 403 });
  }
  return Response.json({ ok: true, productionId: result.productionId, alreadyMember: result.alreadyMember });
}
