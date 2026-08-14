import type { Metadata } from "next";
export const metadata: Metadata = { title: "数据迁移" };

import { requireAdminAccess } from "@/lib/admin-guard";
import AdminPlaceholder from "../_placeholder";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);
  return <AdminPlaceholder eyebrow="项目设置" title="数据迁移" description="剧本、构作等批量导入" />;
}
