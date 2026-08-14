import type { Metadata } from "next";
export const metadata: Metadata = { title: "报告" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName } from "@/lib/db";
import { listProductionReports } from "@/lib/event-db";
import { isReportViewer } from "@/lib/event-permissions";
import PageHeader from "@/components/PageHeader";
import ProductionReportsClient from "@/components/ProductionReportsClient";
import PageActivationGate from "@/components/PageActivationGate";


export default async function ProductionReportsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const [access, productionName] = await Promise.all([
    getProductionPermissionContext(session.userId, session.isAdmin, productionId),
    getProductionName(productionId),
  ]);
  if (!access) redirect(`/unauthorized?id=${productionId}`);
  // 批B：event:follow 读取职责已拆入三态（成员即可进，内容由 view 行过滤）
  if (!productionName) notFound();

  const canViewDrafts = await isReportViewer(access.permCtx, productionId);
  const reports = await listProductionReports(productionId, session.userId, canViewDrafts);

  return (
    <>
      <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
        <PageHeader eyebrow="Reports" title="报告" side="stage" />
        <ProductionReportsClient
          productionId={productionId}
          reports={reports}
          canViewDrafts={canViewDrafts}
        />
      </div>
      <PageActivationGate productionId={productionId} scope="reports" />
    </>
  );
}
