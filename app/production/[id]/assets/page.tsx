import type { Metadata } from "next";
export const metadata: Metadata = { title: "Assets" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getActiveVersionId } from "@/lib/script/version-db";
import AssetPageClient from "@/components/assets/AssetPageClient";
import PageActivationGate from "@/components/perm/PageActivationGate";
import { listActiveProductionMembers } from "@/lib/perm/member-db";
import { listEventDepartments } from "@/lib/ops/event-db";

export default async function AssetsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect(`/unauthorized?id=${id}`);
  const [versionId, members, allDepts] = await Promise.all([
    getActiveVersionId(id), listActiveProductionMembers(id), listEventDepartments(id),
  ]);

  return (
    <>
      <AssetPageClient
        productionId={id}
        versionId={versionId}
        myUserId={session.userId}
        userName={session.name}
        members={members.map(m => ({ userId: m.userId, name: m.name }))}
        departments={allDepts.filter(d => d.kind === "dept").map(d => ({ id: d.id, name: d.name }))}
      />
      <PageActivationGate productionId={id} scope="assets" />
    </>
  );
}
