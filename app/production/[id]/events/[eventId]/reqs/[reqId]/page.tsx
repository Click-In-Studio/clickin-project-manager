import { redirect } from "next/navigation";

type Ctx = { params: Promise<{ id: string; reqId: string }> };

export default async function ReqLegacyRedirect({ params }: Ctx) {
  const { id, reqId } = await params;
  redirect(`/production/${id}/tasks/${reqId}`);
}
