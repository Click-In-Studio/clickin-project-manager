import { type NextRequest, NextResponse } from "next/server";
import { createNewSessionKey, listChatSessions, getStatus } from "@/lib/agent-gateway/client";
import { requireUser, toErrorResponse } from "@/lib/agent-gateway/http";
import { getProductionPermissionContext, listMyProductionsWithRoles, getUserProfile } from "@/lib/db";
import { requireProductionFeature } from "@/lib/plan";
import { ADMIN_PANEL_NODE_PREFIXES } from "@/lib/permissions";
import { PRODUCTION_ID_RE } from "@/lib/mcp/session-identity";
import { listSessions as listRunnerSessions } from "@/lib/agent-runtime/client";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  try {
    // 分流（#367）：自建运行时的会话从 agent_session 列；网关会话照旧。灰度期两边
    // 并集，按 updatedAt 排序——用户看到的是一张表。AGENT_RUNTIME=runner 时不再连
    // 网关（也不向 UI 报网关的 unconfigured/pairing 横幅）。
    const runnerOnly = process.env.AGENT_RUNTIME === "runner";
    const [runnerSessions, gatewaySessions] = await Promise.all([
      listRunnerSessions(auth.userId),
      // listChatSessions self-connects (lazy singleton), so getStatus() right
      // after reflects the actual connection outcome — including the
      // unconfigured/pairing_required states the UI banner needs.
      runnerOnly ? Promise.resolve([]) : listChatSessions(auth.userId),
    ]);
    const runnerKeys = new Set(runnerSessions.map((s) => s.key));
    const sessions = [...runnerSessions, ...gatewaySessions.filter((s) => !runnerKeys.has(s.key))]
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    // 新建对话选择器需要的制作列表（未归档）——与页面同一套查询
    const profile = await getUserProfile(auth.userId);
    const productions = (
      await listMyProductionsWithRoles(auth.userId, profile?.isAdmin ?? auth.isAdmin, [...ADMIN_PANEL_NODE_PREFIXES] /* listMyProductionsWithRoles 内部为前缀 LIKE ANY 匹配（批G G-2 同步改造） */)
    )
      .filter((p) => !p.archivedAt)
      .map((p) => ({ id: p.id, name: p.name }));
    return NextResponse.json({ sessions, productions, gatewayStatus: runnerOnly ? { state: "connected" } : getStatus() });
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
