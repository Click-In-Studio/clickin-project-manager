import type { Metadata } from "next";
export const metadata: Metadata = { title: "权限模版" };

import { requireAdminAccess } from "@/lib/admin-guard";
import AdminPlaceholder from "../_placeholder";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);
  return <AdminPlaceholder eyebrow="安全设置" title="权限模版" description="Cue 表模版等权限模版管理" />;
}
