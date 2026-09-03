import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName } from "@/lib/db";
import AccessRequestsClient from "@/components/AccessRequestsClient";

export const metadata: Metadata = { title: "资源申请" };

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

  // 流程设置是 owner 面（模版决定「谁能批准权限」，属权限的权限——缺口文档 P0-10）；
  // 门在 SSR 算，与 API 侧 requireGrantGate 空 OR 链同源。
  return (
    <AccessRequestsClient
      productionId={id}
      productionName={productionName ?? ""}
      canManageFlows={access.permCtx.isOwner || access.permCtx.isAdmin}
    />
  );
}
