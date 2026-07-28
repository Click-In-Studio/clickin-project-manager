import ReportViewPage from "../page";

type Ctx = { params: Promise<{ id: string; reportId: string; token: string }> };

export default async function ReportTokenPage({ params }: Ctx) {
  const { id, reportId, token } = await params;
  return ReportViewPage({
    params: Promise.resolve({ id, reportId }),
    searchParams: Promise.resolve({ t: token }),
  });
}
