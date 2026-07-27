import type { Metadata } from "next";
export const metadata: Metadata = { title: "我的项目" };

import MyProjectsClient from "@/components/MyProjectsClient";

export default function MyProjectsPage() {
  return <MyProjectsClient />;
}
