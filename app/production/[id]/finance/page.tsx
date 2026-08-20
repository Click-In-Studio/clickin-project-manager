import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionName, getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { listBudgetCategories, listExpenses, type ExpenseStatus } from "@/lib/finance-db";
import { fmtCny, pctCents, pctUsed, sumCents, toCents } from "@/lib/money";

export const metadata: Metadata = { title: "财务" };

const PAD = "24px clamp(18px, 3vw, 52px) 60px";
const CARD = { background: "white", borderRadius: 12, border: "1px solid var(--line)" } as const;

const STATUS_LABEL: Record<ExpenseStatus, string> = {
  pending: "待审批", approved: "已入账", rejected: "已驳回", cancelled: "已撤回",
};

export default async function FinancePage({ params }: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { id } = await params;
  const name = await getProductionName(id);
  if (!name) notFound();

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect(`/unauthorized?id=${id}`);
  const actor = toActor(session, access.permCtx);

  // 预算与支出是**两个独立的面**，权限也分开发（lib/finance-db.ts 的节点表达）：
  // 设计人员可能只看得到预算额度（决定自己的方案往哪个档位放），却看不到别人报了
  // 什么账；报销人则相反。所以这里各查各的，有哪面就画哪面，一面都没有才拦在门外。
  const [canBudget, canExpenses] = await Promise.all([
    hasEffectiveGrant(actor, id, "finance", "*", "budget", "view"),
    hasEffectiveGrant(actor, id, "finance", "*", "expenses", "view"),
  ]);
  if (!canBudget && !canExpenses)
    redirect(`/unauthorized?resource=node%3Afinance%2F*%2Fbudget%40view&id=${id}`);

  const [categories, expenses] = await Promise.all([
    canBudget ? listBudgetCategories(id) : Promise.resolve([]),
    canExpenses ? listExpenses(id) : Promise.resolve([]),
  ]);

  // 合计走整数分（lib/money.ts）：NUMERIC(14,2) 贴着双精度的安全区，
  // 「总预算 − 已使用」用浮点减会漏出 ¥370,000.00000000001 这种尾巴
  const budgetCents = sumCents(categories.map(c => c.amount));
  const spentCents = sumCents(categories.map(c => c.spent));
  const summary: [string, string][] = [
    [fmtCny(budgetCents), "总预算"],
    [fmtCny(spentCents), "已使用"],
    [fmtCny(budgetCents - spentCents), "可用余额"],
    [`${pctCents(spentCents, budgetCents)}%`, "预算执行率"],
  ];

  const empty = (text: string, hint: string) => (
    <div style={{ padding: "36px 20px", textAlign: "center", color: "var(--muted)" }}>
      <p style={{ fontSize: 12, marginBottom: 6 }}>{text}</p>
      <p style={{ fontSize: 10 }}>{hint}</p>
    </div>
  );

  return (
    <div style={{ padding: PAD, minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow="Finance" title="财务" side="stage" />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>预算 · 支出 · 关联</p>
      </div>

      {canBudget && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 18 }}>
          {summary.map(([value, label]) => (
            <div key={label} style={{ ...CARD, padding: "20px" }}>
              <strong style={{ display: "block", fontFamily: "Georgia, serif", color: "var(--ink)", fontSize: 24, fontWeight: 500 }}>{value}</strong>
              <span style={{ display: "block", marginTop: 5, color: "var(--muted)", fontSize: 11 }}>{label}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{
        display: "grid",
        // 只看得到一面时就别留半幅空栏
        gridTemplateColumns: canBudget && canExpenses ? "minmax(0, 1.15fr) minmax(300px, .85fr)" : "minmax(0, 1fr)",
        gap: 16,
      }}>
        {canBudget && (
          <section style={{ ...CARD, padding: 20 }}>
            <p style={{ margin: "0 0 16px", fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>预算分类</p>
            {categories.length === 0
              ? empty("还没有预算科目", "建好科目后，支出就能挂到对应科目上")
              : categories.map(item => (
                <div key={item.id} style={{ padding: "12px 0", borderTop: "1px solid var(--line)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11 }}>
                    <b>{item.name}{item.deptName ? <span style={{ marginLeft: 6, color: "var(--muted)", fontWeight: 400 }}>{item.deptName}</span> : null}</b>
                    <span style={{ color: "var(--muted)" }}>{fmtCny(toCents(item.spent))} / {fmtCny(toCents(item.amount))}</span>
                  </div>
                  <div style={{ height: 6, marginTop: 9, borderRadius: 999, background: "var(--surface-2)", overflow: "hidden" }}>
                    {/* 超支时进度条封顶在 100%，但上面的数字照实显示 */}
                    <div style={{ width: `${Math.min(100, pctUsed(item.spent, item.amount))}%`, height: "100%", borderRadius: 999, background: "var(--stage)" }} />
                  </div>
                </div>
              ))}
          </section>
        )}

        {canExpenses && (
          <section style={{ ...CARD, padding: 20 }}>
            <p style={{ margin: "0 0 16px", fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>近期支出</p>
            {expenses.length === 0
              ? empty("还没有支出记录", "提交后会按审批阶梯逐级流转")
              : expenses.slice(0, 12).map(e => (
                <div key={e.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, padding: "12px 0", borderTop: "1px solid var(--line)" }}>
                  <span>
                    <b style={{ display: "block", fontSize: 11, color: "var(--ink)" }}>{e.title}</b>
                    <small style={{ color: "var(--muted)", fontSize: 9 }}>{e.categoryName ?? "未归类"} · {STATUS_LABEL[e.status]}</small>
                  </span>
                  <b style={{ color: "var(--stage)", fontSize: 11 }}>{fmtCny(toCents(e.amount))}</b>
                </div>
              ))}
          </section>
        )}
      </div>
    </div>
  );
}
