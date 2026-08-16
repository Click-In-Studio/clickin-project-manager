import { redirect } from "next/navigation";

// 旧「部门管理」入口已并入「成员与部门」（organization）。
export default async function DepartmentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/production/${id}/admin/organization`);
}
