import type { Metadata } from "next";
export const metadata: Metadata = { title: "本周日程" };

import WeeklyCallClient from "@/components/ops/WeeklyCallClient";

export default function WeeklyCallPage() {
  return <WeeklyCallClient />;
}
