import type { Metadata } from "next";
export const metadata: Metadata = { title: "权限审计" };

import { requireAdminAccess } from "@/lib/admin-guard";
import AdminPlaceholder from "../_placeholder";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);
  return <AdminPlaceholder eyebrow="合规" title="权限审计" description="授权流水查看与强制撤销" />;
}
