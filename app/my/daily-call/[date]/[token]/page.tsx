import { redirect } from "next/navigation";

type Ctx = { params: Promise<{ date: string; token: string }> };

export default async function DailyCallTokenRedirect({ params }: Ctx) {
  const { date, token } = await params;
  redirect(`/my/daily-call?date=${date}&t=${token}`);
}
