import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionName } from "@/lib/db";
import { DEMO_FINANCE, isDemoProduction } from "@/lib/demo-fixtures";

export const metadata: Metadata = { title: "财务" };

export default async function FinancePage({ params }: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { id } = await params;
  const name = await getProductionName(id);
  if (!name) notFound();

  // 财务尚未接真实数据源：版式先做出来，但 fixture 只给演示项目，真实剧组仍是占位卡。
  if (!isDemoProduction(id)) {
    return (
      <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
        <PageHeader eyebrow="Finance" title="财务" side="stage" />
        <div style={{ background: "white", borderRadius: 12, border: "1px solid var(--line)", padding: "48px 32px", textAlign: "center", color: "var(--muted)" }}>
          <p style={{ fontSize: 13, marginBottom: 6 }}>预算 · 支出 · 关联</p>
          <p style={{ fontSize: 11 }}>功能建设中</p>
        </div>
      </div>
    );
  }

  const { summary, categories, expenses } = DEMO_FINANCE;

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow="Finance" title="财务" side="stage" />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>预算 · 支出 · 关联</p>
        <span style={{ padding: "4px 9px", borderRadius: 999, background: "#f2e4d9", color: "var(--stage)", fontSize: 10, fontWeight: 700 }}>演示数据</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 18 }}>
        {summary.map(([value, label]) => (
          <div key={label} style={{ background: "white", borderRadius: 12, border: "1px solid var(--line)", padding: "20px" }}>
            <strong style={{ display: "block", fontFamily: "Georgia, serif", color: "var(--ink)", fontSize: 24, fontWeight: 500 }}>{value}</strong>
            <span style={{ display: "block", marginTop: 5, color: "var(--muted)", fontSize: 11 }}>{label}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.15fr) minmax(300px, .85fr)", gap: 16 }}>
        <section style={{ background: "white", borderRadius: 12, border: "1px solid var(--line)", padding: 20 }}>
          <p style={{ margin: "0 0 16px", fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>预算分类</p>
          {categories.map(item => (
            <div key={item.name} style={{ padding: "12px 0", borderTop: "1px solid var(--line)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11 }}><b>{item.name}</b><span style={{ color: "var(--muted)" }}>{item.used} / {item.budget}</span></div>
              <div style={{ height: 6, marginTop: 9, borderRadius: 999, background: "var(--surface-2)", overflow: "hidden" }}><div style={{ width: `${item.progress}%`, height: "100%", borderRadius: 999, background: "var(--stage)" }} /></div>
            </div>
          ))}
        </section>
        <section style={{ background: "white", borderRadius: 12, border: "1px solid var(--line)", padding: 20 }}>
          <p style={{ margin: "0 0 16px", fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>近期支出</p>
          {expenses.map(([title, category, amount, status]) => (
            <div key={title} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, padding: "12px 0", borderTop: "1px solid var(--line)" }}>
              <span><b style={{ display: "block", fontSize: 11, color: "var(--ink)" }}>{title}</b><small style={{ color: "var(--muted)", fontSize: 9 }}>{category} · {status}</small></span>
              <b style={{ color: "var(--stage)", fontSize: 11 }}>{amount}</b>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
