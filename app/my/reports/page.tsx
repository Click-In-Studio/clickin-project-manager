import type { Metadata } from "next";
export const metadata: Metadata = { title: "报告" };

import ReportsClient from "@/components/ops/ReportsClient";

export default function ReportsPage() {
  return <ReportsClient />;
}
