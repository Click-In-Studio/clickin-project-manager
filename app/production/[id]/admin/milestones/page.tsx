import type { Metadata } from "next";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
export const metadata: Metadata = { title: "里程碑" };

import { requireAdminAccess } from "@/lib/perm/admin-guard";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getProductionName } from "@/lib/production/production-db";
import { listMilestones } from "@/lib/ops/milestone-db";
import { getSession } from "@/lib/account/session";
import { cookies } from "next/headers";
import AdminMilestonesClient from "@/components/admin/AdminMilestonesClient";

export default async function MilestonesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);

  const [milestones, name, access] = await Promise.all([
    listMilestones(id),
    getProductionName(id),
    session
      ? getProductionPermissionContext(session.userId, session.isAdmin, id)
      : Promise.resolve(null),
  ]);

  const permCtx = access?.permCtx ?? null;

  return (
    <AdminMilestonesClient
      productionId={id}
      productionName={name ?? ""}
      initialMilestones={milestones.map(m => ({
        id: m.id,
        name: m.name,
        endDate: m.endDate,
        sortOrder: m.sortOrder,
      }))}
      canCreate={!!permCtx && await hasEffectiveGrant(permCtx, id, "milestone", "*", "*", "create")}
      canManage={!!permCtx && await hasEffectiveGrant(permCtx, id, "milestone", "*", "*", "edit")}
      canDelete={!!permCtx && await hasEffectiveGrant(permCtx, id, "milestone", "*", "*", "delete")}
    />
  );
}
