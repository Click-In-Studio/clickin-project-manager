import type { Metadata } from "next";
export const metadata: Metadata = { title: "成员与部门" };

import { requireAdminAccess } from "@/lib/admin-guard";
import AdminPlaceholder from "../_placeholder";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);
  return <AdminPlaceholder eyebrow="组织架构" title="成员与部门" description="成员邀请、部门归属与 POC 管理" />;
}
