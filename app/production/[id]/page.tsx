import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionName, getProductionPermissionContext } from "@/lib/db";
import ProductionHomeClient from "@/components/ProductionHomeClient";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const name = await getProductionName(id);
  return { title: name ?? "项目" };
}

export default async function ProductionDashboard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const [name, access] = await Promise.all([
    getProductionName(id),
    getProductionPermissionContext(session.userId, session.isAdmin, id),
  ]);
  if (!access || !name) redirect("/");

  return <ProductionHomeClient productionId={id} productionName={name} />;
}
