import AdminActivationGate from "@/components/AdminActivationGate";

export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AdminActivationGate productionId={id}>{children}</AdminActivationGate>;
}
