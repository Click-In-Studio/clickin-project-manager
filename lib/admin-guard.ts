import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { ADMIN_PANEL_PERMISSIONS } from "@/lib/permissions";

export async function requireAdminAccess(productionId: string) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) redirect("/");

  const { permCtx } = access;
  // Gate uses role eligibility (memberPermissions), not active grants, so producers who
  // haven't confirmed their grants yet can still enter and activate them inside admin.
  const canAdmin =
    session.isAdmin ||
    permCtx.isOwner ||
    (permCtx.memberPermissions !== null &&
      [...ADMIN_PANEL_PERMISSIONS].some((p) => permCtx.memberPermissions!.has(p)));
  if (!canAdmin) redirect(`/production/${productionId}`);
}
