import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionName } from "@/lib/db";
import { DEMO_MATERIALS, isDemoProduction } from "@/lib/demo-fixtures";

export const metadata: Metadata = { title: "实体物料" };

export default async function MaterialsPage({ params }: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { id } = await params;
  const name = await getProductionName(id);
  if (!name) notFound();

  // 同 finance：资产盘点未接真实数据源，fixture 只给演示项目。
  if (!isDemoProduction(id)) {
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

  const { summary, items: materials } = DEMO_MATERIALS;

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow="Materials" title="资产盘点" side="stage" />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>道具 · 服装 · 设备</p>
        <span style={{ padding: "4px 9px", borderRadius: 999, background: "#f2e4d9", color: "var(--stage)", fontSize: 10, fontWeight: 700 }}>演示数据</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 18 }}>
        {summary.map(([value, label]) => (
          <div key={label} style={{ background: "white", borderRadius: 12, border: "1px solid var(--line)", padding: "18px 20px" }}>
            <strong style={{ display: "block", fontFamily: "Georgia, serif", color: "var(--ink)", fontSize: 24, fontWeight: 500 }}>{value}</strong>
            <span style={{ display: "block", marginTop: 4, color: "var(--muted)", fontSize: 11 }}>{label}</span>
          </div>
        ))}
      </div>
      <div style={{ overflowX: "auto", background: "white", borderRadius: 12, border: "1px solid var(--line)" }}>
        <div style={{ minWidth: 720 }}>
          <div style={{ display: "grid", gridTemplateColumns: "90px 1.6fr .7fr .8fr .7fr .7fr", gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--line)", color: "var(--muted)", fontSize: 9, fontWeight: 700, letterSpacing: ".08em" }}>
            <span>编号</span><span>名称</span><span>分类</span><span>负责人</span><span>状态</span><span>位置</span>
          </div>
          {materials.map(item => (
            <div key={item.code} style={{ display: "grid", gridTemplateColumns: "90px 1.6fr .7fr .8fr .7fr .7fr", gap: 12, alignItems: "center", padding: "14px 16px", borderBottom: "1px solid var(--line)", fontSize: 11 }}>
              <code style={{ color: "var(--stage)" }}>{item.code}</code>
              <b style={{ color: "var(--ink)" }}>{item.name}</b>
              <span>{item.category}</span><span>{item.owner}</span>
              <span style={{ color: item.status.includes("待") || item.status.includes("制作") ? "#b45309" : "var(--muted)" }}>{item.status}</span>
              <span style={{ color: "var(--muted)" }}>{item.location}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
