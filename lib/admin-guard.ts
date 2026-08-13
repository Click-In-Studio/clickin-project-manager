import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasAdminPanelEligibility } from "@/lib/permissions";

export async function requireAdminAccess(productionId: string) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) redirect("/");

  const { permCtx } = access;
  // Gate uses role eligibility (memberPermissions), not active grants, so producers who
  // haven't confirmed their grants yet can still enter and activate them inside admin.
  // 批G G-2：管理面资格=治理域节点键前缀（修复批F 后 ADMIN_PANEL 空集恒 false 的 bug）
  const canAdmin =
    session.isAdmin ||
    permCtx.isOwner ||
    hasAdminPanelEligibility(permCtx.memberPermissions);
  if (!canAdmin) redirect(`/production/${productionId}`);
}
