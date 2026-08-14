import { getSession, type SessionData } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasGrant } from "@/lib/grant-check";
import type { NextRequest } from "next/server";

// ─── API route 统一节点门（管理后台 v3）────────────────────────────────────────
// bypass（平台 admin / 项目 owner / permCtx.isAdmin）→ grants OR 链逐一判。
// 写操作默认拦归档项目（blockArchived 显式关闭可豁免）。
// 治理键护栏等额外判定仍在各 route 内做——本 helper 只收敛「session→ctx→OR 链→归档」样板。

import type { GrantVerb } from "@/lib/grant-check";

export type GrantTuple = [resourceType: string, resourceSub: string, verb: GrantVerb];

export type GateResult = {
  deny: Response | null;
  session: SessionData | null;
  access: Awaited<ReturnType<typeof getProductionPermissionContext>> | null;
};

export async function requireGrantGate(
  req: NextRequest,
  productionId: string,
  grants: GrantTuple[],
  opts: { blockArchived?: boolean } = {},
): Promise<GateResult> {
  const session = getSession(req.cookies);
  if (!session) {
    return { deny: Response.json({ error: "未登录" }, { status: 401 }), session: null, access: null };
  }
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) {
    return { deny: Response.json({ error: "无权访问" }, { status: 403 }), session, access: null };
  }
  const { permCtx } = access;
  let ok = session.isAdmin || permCtx.isAdmin || permCtx.isOwner;
  if (!ok) {
    for (const [type, sub, verb] of grants) {
      if (await hasGrant(permCtx.userId, productionId, type, "*", sub, verb)) { ok = true; break; }
    }
  }
  if (!ok) {
    return { deny: Response.json({ error: "权限不足" }, { status: 403 }), session, access };
  }
  if (opts.blockArchived && access.isArchived) {
    return { deny: Response.json({ error: "已归档的项目不可修改" }, { status: 403 }), session, access };
  }
  return { deny: null, session, access };
}
