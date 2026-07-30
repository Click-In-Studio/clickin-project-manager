import type { Metadata } from "next";
export const metadata: Metadata = { title: "报告" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName } from "@/lib/db";
import { listProductionReports } from "@/lib/event-db";
import { isReportViewer } from "@/lib/event-permissions";
import ProductionReportsClient from "@/components/ProductionReportsClient";


export default async function ProductionReportsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const [access, productionName] = await Promise.all([
    getProductionPermissionContext(session.userId, session.isAdmin, productionId),
    getProductionName(productionId),
  ]);
  if (!access) redirect(`/unauthorized?resource=${encodeURIComponent("项目")}&id=${productionId}`);
  if (!productionName) notFound();

  const canViewDrafts = isReportViewer(access.permCtx);
  const reports = await listProductionReports(productionId, session.userId, canViewDrafts);

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <div>
        <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)" }}>Reports</p>
        <h1 style={{ margin: "0 0 20px", fontSize: 20, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em" }}>报告</h1>
      </div>
      <ProductionReportsClient
        productionId={productionId}
        reports={reports}
        canViewDrafts={canViewDrafts}
      />
    </div>
  );
}
