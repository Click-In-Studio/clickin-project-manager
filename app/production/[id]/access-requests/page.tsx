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

  return <AccessRequestsClient productionId={id} productionName={productionName ?? ""} />;
}
