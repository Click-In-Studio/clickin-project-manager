import type { Metadata } from "next";
export const metadata: Metadata = { title: "公告与风险提醒" };

import AnnouncementsClient from "@/components/AnnouncementsClient";

export default function AnnouncementsPage() {
  return <AnnouncementsClient />;
}
