import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasGrant } from "@/lib/grant-check";
import { findProducers } from "@/lib/approval-routing";
import {
  listResourceApprovers,
  listDelegableResourceTypes,
  setResourceApprovers,
  NON_DELEGABLE_RESOURCE_TYPES,
  ResourceApproverError,
  resourceApproverErrorMessage,
} from "@/lib/resource-approver-db";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 资源审批人配置（#262）。
 *
 * 门：owner / 制作人 / 持 production 授权管理面（grants@edit）者可写，另加 grants@view 可读。
 * 制作人显式在门内是本 issue 的题眼——issue 说的正是「制作人/owner 无法把这类审批委派
 * 出去」。只认 grants@edit 的话，制作人还得先去要一行治理授权才能委派，等于没修。
 *
 * 写入的语义（含「配审批方 = 给共管权」这一层）见 lib/resource-approver-db.ts 文件头。
 */
async function gate(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { deny: Response.json({ error: "未登录" }, { status: 401 }) } as const;

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { deny: Response.json({ error: "无权访问" }, { status: 403 }) } as const;

  const { permCtx } = access;
  const bypass = permCtx.isAdmin || permCtx.isOwner;
  const canEdit = bypass
    || (await findProducers(productionId)).includes(permCtx.userId)
    || await hasGrant(permCtx.userId, productionId, "production", "*", "grants", "edit");
  const canView = canEdit
    || await hasGrant(permCtx.userId, productionId, "production", "*", "grants", "view");

  return { deny: null, userId: permCtx.userId, canEdit, canView, isArchived: access.isArchived } as const;
}

// GET — 已配的类型级审批人 + 可配类型清册 + 不可委派清单（供前端如实展示，而非藏起来）
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const g = await gate(req, id);
  if (g.deny) return g.deny;
  if (!g.canView) return Response.json({ error: "权限不足" }, { status: 403 });

  const [approvers, types] = await Promise.all([
    listResourceApprovers(id),
    listDelegableResourceTypes(),
  ]);
  return Response.json({
    approvers,
    delegableTypes: types,
    nonDelegableTypes: NON_DELEGABLE_RESOURCE_TYPES,
    canEdit: g.canEdit,
  });
}

// PUT — 覆盖式保存某类型的审批人。Body: { resourceType, deptIds, userIds }
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const g = await gate(req, id);
  if (g.deny) return g.deny;
  if (!g.canEdit) return Response.json({ error: "权限不足" }, { status: 403 });
  if (g.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    resourceType?: unknown; deptIds?: unknown; userIds?: unknown;
  };
  const resourceType = typeof body.resourceType === "string" ? body.resourceType : "";
  if (!resourceType) return Response.json({ error: "缺少 resourceType" }, { status: 400 });

  const asIds = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
  const deptIds = asIds(body.deptIds ?? []);
  const userIds = asIds(body.userIds ?? []);
  if (!deptIds || !userIds) return Response.json({ error: "deptIds / userIds 必须是字符串数组" }, { status: 400 });

  try {
    const entry = await setResourceApprovers({
      productionId: id, resourceType, deptIds, userIds, establishedBy: g.userId,
    });
    return Response.json({ entry });
  } catch (e) {
    if (e instanceof ResourceApproverError) {
      return Response.json({ error: resourceApproverErrorMessage(e.code), code: e.code }, { status: 400 });
    }
    throw e;
  }
}
