import type { Metadata } from "next";
import PageHeader from "@/components/ui/PageHeader";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/account/session";
import { getProductionName } from "@/lib/production/production-db";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { listMaterials } from "@/lib/ops/material-db";
import responsive from "@/components/ops/responsive.module.css";

export const metadata: Metadata = { title: "实体物料" };

const PAD = "24px clamp(18px, 3vw, 52px) 60px";
const CARD = { background: "white", borderRadius: 12, border: "1px solid var(--line)" } as const;
const COLS = "90px 1.6fr .7fr .8fr .7fr .7fr";

export default async function MaterialsPage({ params }: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { id } = await params;
  const name = await getProductionName(id);
  if (!name) notFound();

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect(`/unauthorized?id=${id}`);
  const actor = toActor(session, access.permCtx);
  if (!await hasEffectiveGrant(actor, id, "material", "*", "*", "view"))
    redirect(`/unauthorized?resource=node%3Amaterial%2F*%40view&id=${id}`);

  const materials = await listMaterials(id);
  // 统计物料种类，不把卷、台、米等不同单位相加；同一物料可分布在多个状态。
  const statusCards = [
    ["有待到货", "expectedQuantity"], ["有在库", "inStockQuantity"],
    ["有签出", "checkedOutQuantity"], ["有维修", "maintenanceQuantity"],
    ["有退出", "exitedQuantity"],
    ["有取消", "cancelledQuantity"],
  ].map(([label, key]) => ({ label, value: String(materials.filter(m =>
    Number(m[key as keyof typeof m]) > 0).length), color: null as string | null }));

  return (
    <div style={{ padding: PAD, minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow="Materials" title="资产盘点" side="stage" />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>道具 · 服装 · 设备</p>
      </div>

      {materials.length === 0 ? (
        <div style={{ ...CARD, padding: "48px 32px", textAlign: "center", color: "var(--muted)" }}>
          <p style={{ fontSize: 13, marginBottom: 6 }}>还没有物料</p>
          <p style={{ fontSize: 11 }}>道具、服装、设备都可以登记在这里</p>
        </div>
      ) : (
        <>
          <div className={`${responsive.metricGrid} ${responsive.materialMetricGrid}`}>
            {[{ label: "物料总数", value: String(materials.length), color: null as string | null },
              ...statusCards,
            ].map(card => (
              <div key={card.label} className={`${responsive.metricCard} ${responsive.materialMetricCard}`}>
                <strong className={`${responsive.metricValue} ${responsive.materialMetricValue}`} style={{ color: card.color ?? "var(--ink)" }}>{card.value}</strong>
                <span className={`${responsive.metricLabel} ${responsive.materialMetricLabel}`}>{card.label}</span>
              </div>
            ))}
          </div>

          <div style={{ overflowX: "auto", ...CARD }}>
            <div style={{ minWidth: 720 }}>
              <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--line)", color: "var(--muted)", fontSize: 9, fontWeight: 700, letterSpacing: ".08em" }}>
                <span>编号</span><span>名称</span><span>分类</span><span>负责方</span><span>库存数量</span><span>登记库位</span>
              </div>
              {materials.map(item => (
                <div key={item.id} style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, alignItems: "center", padding: "14px 16px", borderBottom: "1px solid var(--line)", fontSize: 11 }}>
                  <code style={{ color: "var(--stage)" }}>{item.code}</code>
                  <b style={{ color: "var(--ink)" }}>{item.name}</b>
                  <span>{item.category || "—"}</span>
                  {/* 责任方是部门**或**用户组（二选一，见 lib/ops/task-poc.ts 的 TaskSubject） */}
                  <span>{item.departmentName ?? item.groupName ?? "—"}</span>
                  <span>在库 {item.inStockQuantity}{item.unit} · 签出 {item.checkedOutQuantity}{item.unit}
                    {item.expectedQuantity > 0 && ` · 待到货 ${item.expectedQuantity}${item.unit}`}
                    {item.maintenanceQuantity > 0 && ` · 维修 ${item.maintenanceQuantity}${item.unit}`}
                    {item.exitedQuantity > 0 && ` · 退出 ${item.exitedQuantity}${item.unit}`}
                    {item.cancelledQuantity > 0 && ` · 取消 ${item.cancelledQuantity}${item.unit}`}</span>
                  <span style={{ color: "var(--muted)" }}>{item.location || "—"}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
