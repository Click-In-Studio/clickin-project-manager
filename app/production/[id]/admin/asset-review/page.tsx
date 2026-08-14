import type { Metadata } from "next";
export const metadata: Metadata = { title: "数字资产审查" };

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdminAccess } from "@/lib/admin-guard";
import { getSession } from "@/lib/session";
import { hasGrant } from "@/lib/grant-check";
import { getProductionPermissionContext, getProductionName } from "@/lib/db";
import { listPrivateAssets } from "@/lib/asset-review-db";
import AdminAssetReviewClient from "@/components/AdminAssetReviewClient";

export default async function AssetReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");
  const { permCtx } = access;
  const bypass = permCtx.isAdmin || permCtx.isOwner;

  const [canEdit, canViewOnly] = await Promise.all([
    bypass || hasGrant(permCtx.userId, id, "production", "*", "asset_review", "edit"),
    bypass || hasGrant(permCtx.userId, id, "production", "*", "asset_review", "view"),
  ]);
  const canView = canEdit || canViewOnly;
  if (!canView) redirect(`/production/${id}/admin`);

  const [name, assets] = await Promise.all([
    getProductionName(id),
    listPrivateAssets(id),
  ]);

  return (
    <AdminAssetReviewClient
      productionId={id}
      productionName={name ?? ""}
      initialAssets={assets}
      canEdit={canEdit}
    />
  );
}
