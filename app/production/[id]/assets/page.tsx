import type { Metadata } from "next";
export const metadata: Metadata = { title: "Assets" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { canUserAccessProduction } from "@/lib/db";
import AssetPageClient from "@/components/assets/AssetPageClient";

export default async function AssetsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const ok = session.isAdmin || (await canUserAccessProduction(session.openId, id));
  if (!ok) redirect("/");

  const versionId = cookieStore.get(`ver_${id}`)?.value ?? null;

  return (
    <AssetPageClient
      productionId={id}
      versionId={versionId}
      myOpenId={session.openId}
      isAdmin={session.isAdmin}
      userName={session.name}
    />
  );
}
