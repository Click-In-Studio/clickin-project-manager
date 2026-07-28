import { redirect } from "next/navigation";
export default async function AdminIndexPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/production/${id}/admin/departments`);
}
