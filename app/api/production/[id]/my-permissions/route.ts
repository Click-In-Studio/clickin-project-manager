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
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getPool } from "@/lib/pg";

import { PAGE_PERMISSION_SCOPES } from "@/lib/page-permission-scopes";
import {
  parseNodeKey,
  canAccessNode,
  selfConfirmTemplateNodes,
  type NodeKeyParts,
} from "@/lib/grant-template";

// 激活面节点目录：各页面 scope 中声明的全部树节点键（去重）
const NODE_KEYS: readonly string[] = [
  ...new Set(
    Object.values(PAGE_PERMISSION_SCOPES).flatMap((s) =>
      [...s].filter((k) => k.startsWith("node:")),
    ),
  ),
];

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;

  // 终局（批G G-2）：原子键退役——激活面只余树节点键管道
  const permissions: Record<string, { granted: boolean; selfConfirmable: boolean }> = {};
  for (const key of NODE_KEYS) {
    const node = parseNodeKey(key);
    if (!node) continue;
    const result = await canAccessNode(
      permCtx, productionId,
      node.resourceType, node.resourceId, node.resourceSub, node.verb,
    );
    permissions[key] = {
      granted: result.allowed,
      selfConfirmable: !result.allowed && result.reason === "needs_self_confirm",
    };
  }

  return Response.json({ permissions });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const { permCtx } = access;

  const body = await req.json() as { permissions?: unknown };
  if (!Array.isArray(body.permissions) || body.permissions.length === 0) {
    return Response.json({ error: "permissions 为必填数组" }, { status: 400 });
  }

  const nodeConfirm: NodeKeyParts[] = [];
  for (const raw of body.permissions) {
    if (typeof raw !== "string" || !raw.startsWith("node:")) {
      return Response.json({ error: `无效的权限值: ${raw}` }, { status: 400 });
    }
    // 树节点键：目录内 + 模板资格双重校验（selfConfirmTemplateNodes 内部防伪造；
    // SENSITIVE/ROOT 由 isSensitiveNode/isRootNode 在管道内拒绝）
    const node = parseNodeKey(raw);
    if (!node || !NODE_KEYS.includes(raw)) {
      return Response.json({ error: `无效的权限值: ${raw}` }, { status: 400 });
    }
    nodeConfirm.push(node);
  }

  let nodeConfirmed = 0;
  if (nodeConfirm.length > 0) {
    nodeConfirmed = await selfConfirmTemplateNodes(session.userId, productionId, nodeConfirm);
  }
  return Response.json({ ok: true, confirmed: nodeConfirmed });
}

