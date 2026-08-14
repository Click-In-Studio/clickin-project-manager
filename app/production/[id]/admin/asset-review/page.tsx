import type { Metadata } from "next";
export const metadata: Metadata = { title: "数字资产审查" };

import { requireAdminAccess } from "@/lib/admin-guard";
import AdminPlaceholder from "../_placeholder";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);
  return <AdminPlaceholder eyebrow="合规" title="数字资产审查" description="越隐私查看与管理未公开数字资产" />;
}
