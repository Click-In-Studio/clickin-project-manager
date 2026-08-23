import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { acceptInvite, claimInvite } from "@/lib/invite-db";

const REASON_MSG: Record<string, string> = {
  not_found: "邀请不存在",
  revoked: "邀请已被撤销",
  expired: "邀请已过期",
  exhausted: "邀请使用次数已用完",
  email_mismatch: "该邀请为定向邀请，与当前登录邮箱不符",
  target_mismatch: "该邀请为定向邀请，与当前登录身份不符",
  needs_claim: "该邀请为名单认领链接，请选择你的名字",
  claim_taken: "该名额已被认领",
  seats_full: "该项目成员人数已达当前档位上限，请联系项目所有者升级项目档位",
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
