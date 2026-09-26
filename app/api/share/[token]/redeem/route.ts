import { type NextRequest, NextResponse } from "next/server";
import {
  getAssetShareLinkAccess,
  redeemOneTimeAssetShareLink,
  SHARE_SESSION_COOKIE,
  touchAssetShareSession,
} from "@/lib/asset/share-link-db";
import { isPolicyOn } from "@/lib/perm/policy-db";

type Ctx = { params: Promise<{ token: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;
  const currentSecret = req.cookies.get(SHARE_SESSION_COOKIE)?.value;
  const access = await getAssetShareLinkAccess(token, currentSecret);

  // 已兑换浏览器用同一路由做心跳；数据层会把 last_seen 写放大限制在每 5 分钟一次。
  if (access.kind === "valid" && access.link.oneTime) {
    if (!await isPolicyOn(access.link.productionId, "policy.share_token_enabled")) {
      return Response.json({ error: "链接无效或已过期" }, { status: 404 });
    }
    await touchAssetShareSession(access.link);
    return Response.json({ ok: true });
  }
  if (access.kind !== "requires_redemption") {
    return Response.json({ error: "链接无效、已过期或已被使用" }, { status: 404 });
  }
  if (!await isPolicyOn(access.link.productionId, "policy.share_token_enabled")) {
    return Response.json({ error: "链接无效或已过期" }, { status: 404 });
  }

  const redeemed = await redeemOneTimeAssetShareLink(token);
  if (redeemed.kind !== "redeemed") {
    return Response.json({ error: "链接无效、已过期或已被使用" }, { status: 404 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SHARE_SESSION_COOKIE, redeemed.sessionSecret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: `/api/share/${token}`,
    maxAge: Math.max(1, Math.floor((redeemed.link.sessionExpiresAt!.getTime() - Date.now()) / 1000)),
  });
  return response;
}
