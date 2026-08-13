import type { Metadata } from "next";
import { hasGrant } from "@/lib/grant-check";
export const metadata: Metadata = { title: "里程碑" };

import { requireAdminAccess } from "@/lib/admin-guard";
import { getProductionPermissionContext, listMilestones } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { getSession } from "@/lib/session";
import { cookies } from "next/headers";
import AdminMilestonesClient from "@/components/AdminMilestonesClient";

export default async function MilestonesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);

  const [milestones, access] = await Promise.all([
    listMilestones(id),
    session
      ? getProductionPermissionContext(session.userId, session.isAdmin, id)
      : Promise.resolve(null),
  ]);

  const permCtx = access?.permCtx ?? null;

  return (
    <AdminMilestonesClient
      productionId={id}
      initialMilestones={milestones.map(m => ({
        id: m.id,
        name: m.name,
        endDate: m.endDate,
        sortOrder: m.sortOrder,
      }))}
      canCreate={!!permCtx && (permCtx.isAdmin || await hasGrant(permCtx.userId, id, "milestone", "*", "*", "create"))}
      canManage={!!permCtx && (permCtx.isAdmin || await hasGrant(permCtx.userId, id, "milestone", "*", "*", "edit"))}
      canDelete={!!permCtx && (permCtx.isAdmin || await hasGrant(permCtx.userId, id, "milestone", "*", "*", "delete"))}
    />
  );
}
