import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionName } from "@/lib/db";

export const metadata: Metadata = { title: "实体物料" };

export default async function MaterialsPage({ params }: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { id } = await params;
  const name = await getProductionName(id);
  if (!name) notFound();

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow="Materials" title="资产盘点" side="stage" />
      <div style={{ background: "white", borderRadius: 12, border: "1px solid var(--line)", padding: "48px 32px", textAlign: "center", color: "var(--muted)" }}>
        <p style={{ fontSize: 13, marginBottom: 6 }}>道具 · 服装 · 设备</p>
        <p style={{ fontSize: 11 }}>功能建设中</p>
      </div>
    </div>
  );
}
