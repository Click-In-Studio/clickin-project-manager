import type { Metadata } from "next";
export const metadata: Metadata = { title: "通知提醒" };

import MyNotificationsClient from "@/components/MyNotificationsClient";

export default function NotificationsPage() {
  return <MyNotificationsClient />;
}
