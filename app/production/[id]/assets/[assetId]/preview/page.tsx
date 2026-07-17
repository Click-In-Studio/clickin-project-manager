import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { getSession } from "@/lib/session";
import { canUserAccessProduction } from "@/lib/db";
import { getAsset } from "@/lib/asset-db";
import AssetPreviewClient from "@/components/assets/AssetPreviewClient";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; assetId: string }>;
}): Promise<Metadata> {
  const { assetId } = await params;
  const asset = await getAsset(assetId);
  return { title: asset ? (asset.name ?? asset.fileName) : "预览" };
}

export default async function AssetPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; assetId: string }>;
  searchParams: Promise<{ v?: string }>;
}) {
  const { id, assetId } = await params;
  const { v: versionId } = await searchParams;

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const ok = session.isAdmin || (await canUserAccessProduction(session.openId, id));
  if (!ok) redirect("/");

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) notFound();

  return (
    <AssetPreviewClient
      productionId={id}
      assetId={assetId}
      versionId={versionId ?? null}
      fileName={asset.name ?? asset.fileName}
      mimeType={asset.mimeType}
      storageType={asset.storageType}
      feishuUrl={asset.feishuUrl}
      userName={session.name}
    />
  );
}
