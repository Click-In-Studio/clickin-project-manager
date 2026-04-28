import DailyCallPage from "../../page";
import type { Metadata } from "next";
export const metadata: Metadata = { title: "当日 Call Sheet" };

type Ctx = { params: Promise<{ date: string; token: string }> };

export default async function DailyCallTokenPage({ params }: Ctx) {
  const { date, token } = await params;
  return DailyCallPage({ searchParams: Promise.resolve({ date, t: token }) });
}
