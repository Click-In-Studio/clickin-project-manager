import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getProductionName } from "@/lib/production/production-db";
import ApprovalCenterClient from "@/components/approval/ApprovalCenterClient";

export const metadata: Metadata = { title: "审批中心" };

export default async function AccessRequestsPage({ params }: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { id } = await params;
  const [access, productionName] = await Promise.all([
    getProductionPermissionContext(session.userId, session.isAdmin, id),
    getProductionName(id),
  ]);
  if (!access) notFound();

  return (
    <ApprovalCenterClient
      productionId={id}
      productionName={productionName ?? ""}
      actorId={session.userId}
      archived={access.isArchived}
    />
  );
}
