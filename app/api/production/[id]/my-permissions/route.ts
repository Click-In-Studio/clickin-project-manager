/**
 * GET  — 当前用户在该演出的权限快照，含是否可自我确认。
 * POST — 批量自我确认原子权限（写入 atomic_permission_grant, grant_source='self_confirmed'）。
 *
 * GET 响应:
 *   {
 *     permissions: Record<Permission, {
 *       granted: boolean;       // hasPermission() 返回 true
 *       selfConfirmable: boolean; // 在角色或科组区间内，尚未激活，可点按钮确认
 *     }>
 *   }
 *
 * POST 请求体: { permissions: string[] }
 * POST 响应:  { ok: true, confirmed: number }
 */
import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";

import {
  parseNodeKey,
  canAccessNodesBatch,
  type NodeKeyParts,
} from "@/lib/perm/grant-template";
import { ACTIVATABLE_NODE_KEYS, activatePendingPermissions } from "@/lib/perm/permission-activation-db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;

  // 终局（批G G-2）：原子键退役——激活面只余树节点键管道。
  // 批量判定：目录 40+ 键，逐键 canAccessNode 等于 160+ 次串行往返，且这条
  // GET 挂在 AppShell 上、每进一次演出就跑一遍。
  const parsed = ACTIVATABLE_NODE_KEYS
    .map((key) => ({ key, node: parseNodeKey(key) }))
    .filter((e): e is { key: string; node: NodeKeyParts } => e.node !== null);
  const results = await canAccessNodesBatch(permCtx, productionId, parsed.map((e) => e.node));

  const permissions: Record<string, { granted: boolean; selfConfirmable: boolean }> = {};
  parsed.forEach(({ key }, i) => {
    const result = results[i];
    permissions[key] = {
      granted: result.allowed,
      selfConfirmable: !result.allowed && result.reason === "needs_self_confirm",
    };
  });

  return Response.json({ permissions });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const body = await req.json() as { permissions?: unknown };
  const result = await activatePendingPermissions(session.userId, productionId, body.permissions);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true, confirmed: result.confirmed });
}
