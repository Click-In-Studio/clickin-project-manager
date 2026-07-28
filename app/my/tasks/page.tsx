import type { Metadata } from "next";
export const metadata: Metadata = { title: "我的任务" };

import MyTasksClient from "@/components/MyTasksClient";

export default function MyTasksPage() {
  return <MyTasksClient />;
}
