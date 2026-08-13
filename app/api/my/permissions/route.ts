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

      // 终局（批G G-2，语义变化有意为之）：原子键全集已退役，"全集枚举 +
      // granted/overridden"无枚举对象。本 API 现返回 role 区间节点串概览：
      //   granted = 区间资格（非活跃行；行判定走 hasGrant）
      //   overridden 恒 false（override 概念随原子键退役——个人区间在
      //   production_member_permission 表，经六步链消费）
      // 形状保留兼容旧消费端；总览页的终局 UI 改造（展示节点树+行）属后续任务。
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
