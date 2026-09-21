import type { Metadata } from "next";
export const metadata: Metadata = { title: "数字资产审查" };

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdminAccess } from "@/lib/perm/admin-guard";
import { getSession } from "@/lib/account/session";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getProductionName } from "@/lib/production/production-db";
import { listPrivateAssets } from "@/lib/asset/review-db";
import AdminAssetReviewClient from "@/components/admin/AdminAssetReviewClient";

export default async function AssetReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");
  const { permCtx } = access;

  const [canEdit, canViewOnly] = await Promise.all([
    hasEffectiveGrant(permCtx, id, "production", "*", "asset_review", "edit"),
    hasEffectiveGrant(permCtx, id, "production", "*", "asset_review", "view"),
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
