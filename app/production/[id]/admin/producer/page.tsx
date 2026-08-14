import type { Metadata } from "next";
export const metadata: Metadata = { title: "管理员设置" };

import { requireAdminAccess } from "@/lib/admin-guard";
import AdminPlaceholder from "../_placeholder";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);
  return <AdminPlaceholder eyebrow="项目设置" title="管理员设置" description="制作人权限与人事管理" />;
}
