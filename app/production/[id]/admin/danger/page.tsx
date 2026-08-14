import type { Metadata } from "next";
export const metadata: Metadata = { title: "危险操作" };

import { requireAdminAccess } from "@/lib/admin-guard";
import AdminPlaceholder from "../_placeholder";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);
  return <AdminPlaceholder eyebrow="项目设置" title="危险操作" description="归档、转让与删除" />;
}
