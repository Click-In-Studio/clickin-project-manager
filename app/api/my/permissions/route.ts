import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { listMemberProductions, getProductionPermissionContext } from "@/lib/db";
import { hasPermission, ALL_PERMISSIONS, type Permission } from "@/lib/permissions";

export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const memberProductions = await listMemberProductions(session.userId);

  const productionResults = await Promise.all(
    memberProductions.map(async (p) => {
      const access = await getProductionPermissionContext(session.userId, session.isAdmin, p.id);
      if (!access) return null;
      const { permCtx } = access;

      const permissions: Record<Permission, { granted: boolean; overridden: boolean }> = {} as never;
      for (const perm of ALL_PERMISSIONS) {
        permissions[perm] = {
          granted: hasPermission(perm, permCtx),
          overridden: permCtx.overrides.has(perm),
        };
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
