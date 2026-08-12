import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { getSession } from "@/lib/session";
import { hasAnyGrant } from "@/lib/grant-check";
import { canViewAsset } from "@/lib/asset-perm";
import { getProductionPermissionContext } from "@/lib/db";
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

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect(`/unauthorized?id=${id}`);
  // 批D：实例可见判定（能力票∧结构 ∨ publication@view），asset 加载后判
  if (!access.permCtx.isAdmin && !await hasAnyGrant(session.userId, id, "asset", ["meta"], "view"))
    redirect(`/unauthorized?resource=asset%3Aview&id=${id}`);

  const asset = await getAsset(assetId);
  if (!asset || asset.productionId !== id) notFound();
  // 批D：实例级可见（能力票∧结构 ∨ publication@view）
  if (!(await canViewAsset(access.permCtx, id, asset, "meta")))
    redirect(`/unauthorized?resource=asset%3Aview&id=${id}`);

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
