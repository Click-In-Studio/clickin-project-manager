import { redirect } from "next/navigation";

type Ctx = { params: Promise<{ token: string }> };

export default async function WeeklyCallTokenRedirect({ params }: Ctx) {
  const { token } = await params;
  redirect(`/my/weekly-call?t=${token}`);
}
