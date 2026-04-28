import WeeklyCallPage from "../page";
import type { Metadata } from "next";
export const metadata: Metadata = { title: "本周 Call 安排" };

type Ctx = { params: Promise<{ token: string }> };

export default async function WeeklyCallTokenPage({ params }: Ctx) {
  const { token } = await params;
  return WeeklyCallPage({ searchParams: Promise.resolve({ t: token }) });
}
