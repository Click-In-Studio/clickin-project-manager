import type { Metadata } from "next";
export const metadata: Metadata = { title: "项目管理" };
import { requireAdminAccess } from "@/lib/admin-guard";
import AdminPlaceholder from "../_placeholder";

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);
  return <AdminPlaceholder eyebrow="Settings" title="项目管理" description="基本信息 · 飞书集成 · 存档与归档" />;
}
