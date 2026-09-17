import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { acceptInvite, claimInvite } from "@/lib/account/invite-db";

const REASON_MSG: Record<string, string> = {
  not_found: "邀请不存在",
  revoked: "邀请已被撤销",
  expired: "邀请已过期",
  exhausted: "邀请使用次数已用完",
  email_mismatch: "该邀请为定向邀请，与当前登录邮箱不符",
  target_mismatch: "该邀请为定向邀请，与当前登录身份不符",
  needs_claim: "该邀请为名单认领链接，请选择你的名字",
  claim_taken: "该名额已被认领",
  // 这句是说给**受邀方**听的（#313）：他既不知道什么是席位也无从解决，只能找发起方。
  // 「确认离组已停用成员 / 升档」那套自解路径在发起侧（lib/account/plan.ts seatsFullMessage）。
  seats_full: "该项目席位已满，暂时无法加入，请联系项目所有者处理后重试",
};

// POST — 接受邀请（登录后）。Body 可选 { claimId }（名单认领链接）。
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return Response.json({ error: "邀请无效" }, { status: 400 });
  }
  const { claimId } = (await req.json().catch(() => ({}))) as { claimId?: string };

  const result = claimId
    ? await claimInvite(token, claimId, session.userId)
    : await acceptInvite(token, session.userId);
  if (!result.ok) {
    return Response.json(
      { error: REASON_MSG[result.reason] ?? "邀请不可用", reason: result.reason },
      { status: result.reason === "not_found" ? 404 : 403 },
    );
  }
  return Response.json({ ok: true, productionId: result.productionId, alreadyMember: result.alreadyMember });
}
