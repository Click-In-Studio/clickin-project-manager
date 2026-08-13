import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { listMemberProductions, getProductionPermissionContext } from "@/lib/db";

export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const memberProductions = await listMemberProductions(session.userId);

  const productionResults = await Promise.all(
    memberProductions.map(async (p) => {
      const access = await getProductionPermissionContext(session.userId, session.isAdmin, p.id);
      if (!access) return null;
      const { permCtx } = access;

      // 终局（批G G-2）：原子键退役——返回 role 区间节点串概览
      const permissions: Record<string, { granted: boolean; overridden: boolean }> = {};
      for (const key of permCtx.memberPermissions ?? []) {
        permissions[key] = { granted: true, overridden: false };
      }

      return {
        id: p.id,
        name: p.name,
        archivedAt: p.archivedAt,
        roles: p.roles,
        permissions,
      };
    }),
  );
  const productions = productionResults.filter((p) => p !== null);

  return Response.json({ isAdmin: session.isAdmin, productions });
}
