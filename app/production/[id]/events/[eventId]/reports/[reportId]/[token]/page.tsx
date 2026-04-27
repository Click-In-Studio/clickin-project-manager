import { redirect } from "next/navigation";

type Ctx = { params: Promise<{ id: string; eventId: string; reportId: string; token: string }> };

export default async function ReportTokenRedirect({ params }: Ctx) {
  const { id, eventId, reportId, token } = await params;
  redirect(`/production/${id}/events/${eventId}/reports/${reportId}?t=${token}`);
}
