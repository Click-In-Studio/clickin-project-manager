import type { Metadata } from "next";
export const metadata: Metadata = { title: "策略中心" };

import { requireAdminAccess } from "@/lib/admin-guard";
import AdminPlaceholder from "../_placeholder";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);
  return <AdminPlaceholder eyebrow="安全设置" title="策略中心" description="各类 Policy 配置" />;
}
