import type { Metadata } from "next";
export const metadata: Metadata = { title: "报告" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { listProductionReports } from "@/lib/event-db";
import { isReportViewer } from "@/lib/event-permissions";
import ProductionReportsClient from "@/components/ProductionReportsClient";
import styles from "@/components/my-pages.module.css";

export default async function ProductionReportsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) redirect("/");

  const canViewDrafts = isReportViewer(access.permCtx);
  const reports = await listProductionReports(productionId, session.userId, canViewDrafts);

  return (
    <div className={styles.workspace}>
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>Reports</p>
        <h1 className={styles.pageTitle}>报告</h1>
      </div>
      <ProductionReportsClient
        productionId={productionId}
        reports={reports}
        canViewDrafts={canViewDrafts}
      />
    </div>
  );
}
