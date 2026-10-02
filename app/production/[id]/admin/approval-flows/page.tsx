import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { requireAdminAccess } from "@/lib/perm/admin-guard";
import { getProductionName } from "@/lib/production/production-db";
import PageHeader from "@/components/ui/PageHeader";
import ApprovalFlowDesigner from "@/components/approval/ApprovalFlowDesigner";
import styles from "@/components/ui/my-pages.module.css";

export const metadata: Metadata = { title: "访问审批流程" };

export default async function ApprovalFlowsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access?.permCtx.isOwner && !session.isAdmin) redirect(`/production/${id}/admin`);

  return (
    <div className={styles.workspace} style={{ minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow={await getProductionName(id) ?? ""} title="访问审批流程" side="stage" />
      <section className={`${styles.responsiveContentPanel} ${styles.responsiveContentPanelFlow}`} style={{
        background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13,
        padding: 22, display: "flex", flexDirection: "column",
      }}>
        <ApprovalFlowDesigner productionId={id} />
      </section>
    </div>
  );
}
