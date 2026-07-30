import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import { getProductionName } from "@/lib/db";
import MyNotificationsClient from "@/components/MyNotificationsClient";

export const metadata: Metadata = { title: "通知" };

export default async function NotificationsModulePage({ params }: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { id } = await params;
  const name = await getProductionName(id);
  if (!name) notFound();

  const productions = [{ id, name }];

  return <MyNotificationsClient productions={productions} productionId={id} />;
}
