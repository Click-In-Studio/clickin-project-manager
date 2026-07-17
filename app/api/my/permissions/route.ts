import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { listMemberProductions, getProductionMemberRoles, getPermissionOverrides } from "@/lib/db";
import { hasPermission, PERMISSION_GROUPS, type Permission } from "@/lib/roles";

const ALL_PERMISSIONS: Permission[] = PERMISSION_GROUPS.flatMap(g => g.perms);

export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const memberProductions = await listMemberProductions(session.userId);

  const productions = await Promise.all(
    memberProductions.map(async (p) => {
      const [roles, overrides] = await Promise.all([
        getProductionMemberRoles(session.userId, p.id),
        getPermissionOverrides(p.id, session.userId),
      ]);

      const effectiveRoles = roles ?? [];

      const permissions: Record<Permission, { granted: boolean; overridden: boolean }> = {} as never;
      for (const perm of ALL_PERMISSIONS) {
        const overridden = overrides.has(perm);
        const granted = hasPermission(perm, session.isAdmin, effectiveRoles, overrides);
        permissions[perm] = { granted, overridden };
      }

      return {
        id: p.id,
        name: p.name,
        archivedAt: p.archivedAt,
        roles: effectiveRoles,
        permissions,
      };
    }),
  );

  return Response.json({ isAdmin: session.isAdmin, productions });
}
