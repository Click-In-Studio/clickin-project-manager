import { redirect } from "next/navigation";

type Ctx = {
  params: Promise<{ id: string; reportId: string }>;
  searchParams: Promise<{ t?: string }>;
};

export default async function ReportLegacyRedirect({ params, searchParams }: Ctx) {
  const { id, reportId } = await params;
  const { t } = await searchParams;
  const base = `/production/${id}/reports/${reportId}`;
  redirect(t ? `${base}/${t}` : base);
}
