import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionName, getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { listMaterials, listMaterialStatuses } from "@/lib/material-db";

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

  const [materials, statuses] = await Promise.all([listMaterials(id), listMaterialStatuses(id)]);

  // 状态是**自由列表不是状态机**（db/add-material-ledger.sql 的立意）——「可用 / 使用中 /
  // 需处理」这种归类需要知道每个状态的语义，而剧组可以自己加状态、改名字。所以这里
  // 不猜语义，按实际状态逐个计数：总数 + 每个在用状态一张卡。剧组加了状态，卡就跟着多。
  const byStatus = new Map<string, number>();
  for (const m of materials) byStatus.set(m.statusId ?? "", (byStatus.get(m.statusId ?? "") ?? 0) + 1);
  const statusCards = statuses
    .filter(s => byStatus.has(s.id))
    .map(s => ({ label: s.name, value: String(byStatus.get(s.id)), color: s.color }));
  const noStatus = byStatus.get("") ?? 0;

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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 18 }}>
            {[{ label: "物料总数", value: String(materials.length), color: null as string | null },
              ...statusCards,
              ...(noStatus ? [{ label: "未设状态", value: String(noStatus), color: null as string | null }] : []),
            ].map(card => (
              <div key={card.label} style={{ ...CARD, padding: "18px 20px" }}>
                <strong style={{ display: "block", fontFamily: "Georgia, serif", color: card.color ?? "var(--ink)", fontSize: 24, fontWeight: 500 }}>{card.value}</strong>
                <span style={{ display: "block", marginTop: 4, color: "var(--muted)", fontSize: 11 }}>{card.label}</span>
              </div>
            ))}
          </div>

          <div style={{ overflowX: "auto", ...CARD }}>
            <div style={{ minWidth: 720 }}>
              <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--line)", color: "var(--muted)", fontSize: 9, fontWeight: 700, letterSpacing: ".08em" }}>
                <span>编号</span><span>名称</span><span>分类</span><span>负责方</span><span>状态</span><span>位置</span>
              </div>
              {materials.map(item => (
                <div key={item.id} style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, alignItems: "center", padding: "14px 16px", borderBottom: "1px solid var(--line)", fontSize: 11 }}>
                  <code style={{ color: "var(--stage)" }}>{item.code}</code>
                  <b style={{ color: "var(--ink)" }}>{item.name}</b>
                  <span>{item.category || "—"}</span>
                  {/* 责任方是部门**或**用户组（二选一，见 lib/task-poc.ts 的 TaskSubject） */}
                  <span>{item.departmentName ?? item.groupName ?? "—"}</span>
                  {/* 颜色取状态自己带的那个，不靠名字里有没有「待」「制作」去猜 */}
                  <span style={{ color: item.statusColor ?? "var(--muted)" }}>{item.statusName ?? "—"}</span>
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
