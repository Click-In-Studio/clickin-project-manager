import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";

export async function requireAdminAccess(productionId: string) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) redirect("/");

  const canAdmin =
    session.isAdmin ||
    hasPermission("members:manage_overrides", access.permCtx) ||
    hasPermission("dept:create", access.permCtx);
  if (!canAdmin) redirect(`/production/${productionId}`);
}
