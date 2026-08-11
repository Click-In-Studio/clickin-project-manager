import { type NextRequest, NextResponse } from "next/server";
import { createNewSessionKey, listChatSessions, getStatus } from "@/lib/agent-gateway/client";
import { requireUser, toErrorResponse } from "@/lib/agent-gateway/http";
import { getProductionPermissionContext, listMyProductionsWithRoles, getUserProfile } from "@/lib/db";
import { ADMIN_PANEL_PERMISSIONS } from "@/lib/permissions";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  try {
    // listChatSessions self-connects (lazy singleton), so getStatus() right
    // after reflects the actual connection outcome — including the
    // unconfigured/pairing_required states the UI banner needs.
    const sessions = await listChatSessions(auth.userId);
    // 新建对话选择器需要的制作列表（未归档）——与页面同一套查询
    const profile = await getUserProfile(auth.userId);
    const productions = (
      await listMyProductionsWithRoles(auth.userId, profile?.isAdmin ?? auth.isAdmin, [...ADMIN_PANEL_PERMISSIONS])
    )
      .filter((p) => !p.archivedAt)
      .map((p) => ({ id: p.id, name: p.name }));
    return NextResponse.json({ sessions, productions, gatewayStatus: getStatus() });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// Doesn't touch the Gateway — a session only springs into existence there on
// its first actual message. This just hands back a fresh per-user key.
// production 会话（可选 productionId）：签发前实时校验成员资格——
// sessionKey 由后端签发是 production 隔离的根，用户无法自造。
export async function POST(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  let productionId: string | undefined;
  try {
    const body = (await req.json().catch(() => ({}))) as { productionId?: unknown };
    if (body.productionId !== undefined) {
      if (typeof body.productionId !== "string" || !/^[a-z0-9]{1,32}$/i.test(body.productionId)) {
        return NextResponse.json({ error: "productionId 格式非法" }, { status: 400 });
      }
      productionId = body.productionId;
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (productionId) {
    const access = await getProductionPermissionContext(auth.userId, auth.isAdmin, productionId).catch(() => null);
    if (!access) {
      return NextResponse.json({ error: "你不是该制作的成员" }, { status: 403 });
    }
  }

  return NextResponse.json({ key: createNewSessionKey(auth.userId, productionId) }, { status: 201 });
}
