import type { Metadata } from "next";
export const metadata: Metadata = { title: "本周日程" };

import { redirect } from "next/navigation";

type Ctx = { params: Promise<{ token: string }> };

export default async function WeeklyCallTokenPage({ params }: Ctx) {
  const { token } = await params;
  redirect(`/my/weekly-call?t=${token}`);
}
