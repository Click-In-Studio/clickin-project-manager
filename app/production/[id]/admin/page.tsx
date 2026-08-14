import type { Metadata } from "next";
export const metadata: Metadata = { title: "项目概览" };

import { requireAdminAccess } from "@/lib/admin-guard";
import { getProductionMeta, getAdminOverviewStats } from "@/lib/db";
import { notFound } from "next/navigation";
import PageHeader from "@/components/PageHeader";

const CARD: React.CSSProperties = {
  minHeight: 92, padding: "17px 19px", display: "flex", alignItems: "center", gap: 13,
  background: "var(--surface)",
};

function StatCard({ num, label, hint }: { num: string; label: string; hint: string }) {
  return (
    <div style={CARD}>
      <span style={{ fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 28, color: "var(--ink)" }}>{num}</span>
      <p style={{ margin: 0, display: "flex", flexDirection: "column" }}>
        <b style={{ fontSize: 11, color: "var(--ink)" }}>{label}</b>
        <small style={{ marginTop: 3, color: "var(--muted)", fontSize: 9 }}>{hint}</small>
      </p>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 16, padding: "11px 0", borderBottom: "1px solid var(--line)", fontSize: 13 }}>
      <span style={{ width: 88, flexShrink: 0, color: "var(--muted)", fontSize: 11, paddingTop: 1 }}>{label}</span>
      <span style={{ color: "var(--ink)", minWidth: 0 }}>{value}</span>
    </div>
  );
}

export default async function AdminOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const [meta, stats] = await Promise.all([
    getProductionMeta(id),
    getAdminOverviewStats(id),
  ]);
  if (!meta) notFound();

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  };

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow={meta.name} title="项目概览" side="stage" />

      {/* ── 基础统计 ── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        <StatCard num={String(stats.memberCount)} label="项目成员" hint={stats.suspendedCount > 0 ? `含 ${stats.suspendedCount} 名已停用` : "全部在职"} />
        <StatCard num={String(stats.deptCount)} label="部门" hint={`另有 ${stats.groupCount} 个用户组`} />
        <StatCard num={String(stats.roleCount)} label="角色" hint="在用职称" />
        <StatCard num={String(stats.activeGrantCount)} label="活跃授权" hint="有效权限行" />
        <StatCard num={String(stats.milestoneCount)} label="里程碑" hint="阶段节点" />
        <StatCard num={String(stats.announcementCount)} label="公告" hint="累计发布" />
      </div>

      {/* ── 项目信息 ── */}
      <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22 }}>
        <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)" }}>
          Production Profile
        </p>
        <h2 style={{ margin: "0 0 14px", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 19, fontWeight: 500, color: "var(--ink)" }}>
          项目信息
        </h2>
        <InfoRow label="名称" value={meta.name} />
        <InfoRow label="类型" value={meta.typeLabel ?? meta.type ?? "未设置"} />
        <InfoRow label="语言" value={meta.language ?? "未设置"} />
        <InfoRow label="创建时间" value={fmtDate(stats.createdAt)} />
        <InfoRow
          label="状态"
          value={stats.archivedAt ? (
            <span style={{ padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: "var(--surface-2)", color: "var(--muted)" }}>
              已归档 · {fmtDate(stats.archivedAt)}
            </span>
          ) : (
            <span style={{ padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: "var(--success-soft)", color: "var(--success)" }}>
              进行中
            </span>
          )}
        />
        <div style={{ display: "flex", gap: 16, padding: "11px 0", fontSize: 13 }}>
          <span style={{ width: 88, flexShrink: 0, color: "var(--muted)", fontSize: 11, paddingTop: 1 }}>简介</span>
          <span style={{ color: meta.description ? "var(--ink)" : "var(--muted)", whiteSpace: "pre-wrap", minWidth: 0 }}>
            {meta.description || "（未填写）"}
          </span>
        </div>
      </section>
    </div>
  );
}
