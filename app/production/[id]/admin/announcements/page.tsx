import type { Metadata } from "next";
export const metadata: Metadata = { title: "通知公告" };
import { requireAdminAccess } from "@/lib/admin-guard";
import AdminPlaceholder from "../_placeholder";

export default async function AnnouncementsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);
  return <AdminPlaceholder eyebrow="Announcements" title="通知公告" description="公告发布 · 群消息 · 风险提醒" />;
}
