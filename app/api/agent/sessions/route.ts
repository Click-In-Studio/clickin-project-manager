import { type NextRequest, NextResponse } from "next/server";
import { requireUser, toErrorResponse } from "@/lib/agent-chat/http";
import { getProductionPermissionContext, listMyProductionsWithRoles, getUserProfile } from "@/lib/db";
import { requireProductionFeature } from "@/lib/plan";
import { ADMIN_PANEL_NODE_PREFIXES } from "@/lib/permissions";
import { PRODUCTION_ID_RE, createNewSessionKey } from "@/lib/mcp/session-identity";
import { listSessions } from "@/lib/agent-runtime/client";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  try {
    const sessions = (await listSessions(auth.userId)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    // 新建对话选择器需要的制作列表（未归档）——与页面同一套查询
    const profile = await getUserProfile(auth.userId);
    const productions = (
      await listMyProductionsWithRoles(auth.userId, profile?.isAdmin ?? auth.isAdmin, [...ADMIN_PANEL_NODE_PREFIXES] /* listMyProductionsWithRoles 内部为前缀 LIKE ANY 匹配（批G G-2 同步改造） */)
    )
      .filter((p) => !p.archivedAt)
      .map((p) => ({ id: p.id, name: p.name }));
    // gatewayStatus：网关已退役，前端横幅逻辑仍认这个字段——恒 connected
    return NextResponse.json({ sessions, productions, gatewayStatus: { state: "connected" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// 只签发一把新 key，不落库——会话行在第一条消息时才建（ensureSession）。
// production 会话（可选 productionId）：签发前实时校验成员资格——
// sessionKey 由后端签发是 production 隔离的根，用户无法自造。
export async function POST(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  // 注意：不能在 req.json() 上挂 .catch(() => ({}))——那会把 malformed
  // JSON 静默当成"无 productionId"签发个人会话（review #206 抓出的死代码
  // + 行为偏差），必须真 400。
  let productionId: string | undefined;
  try {
    const body = (await req.json()) as { productionId?: unknown };
    if (body.productionId !== undefined) {
      if (typeof body.productionId !== "string" || !PRODUCTION_ID_RE.test(body.productionId)) {
        return NextResponse.json({ error: "productionId 格式非法" }, { status: 400 });
      }
      productionId = body.productionId;
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (productionId) {
    // getProductionPermissionContext 对"非成员"本身返回 null（不抛）——
    // 不吞异常：真实基础设施错误（DB 断连等）走 500，别伪装成 403
    try {
      const access = await getProductionPermissionContext(auth.userId, auth.isAdmin, productionId);
      if (!access) {
        return NextResponse.json({ error: "你不是该制作的成员" }, { status: 403 });
      }
      // 项目档位功能门（#280）：独立于成员/grant 判定的一层，档位未开 AI 不签发
      // production 会话。个人会话（无 productionId）不受项目档位约束。
      const planDeny = await requireProductionFeature(productionId, "ai");
      if (planDeny) return planDeny;
    } catch (err) {
      return toErrorResponse(err);
    }
  }

  return NextResponse.json({ key: createNewSessionKey(auth.userId, productionId) }, { status: 201 });
}
