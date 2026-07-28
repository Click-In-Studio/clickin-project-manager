import { redirect } from "next/navigation";

type Ctx = { params: Promise<{ id: string; reportId: string; token: string }> };

export default async function ReportTokenLegacyRedirect({ params }: Ctx) {
  const { id, reportId, token } = await params;
  redirect(`/production/${id}/reports/${reportId}/${token}`);
}
