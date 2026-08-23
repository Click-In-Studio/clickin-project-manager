import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionName, getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import {
  listBudgetCategories, listBudgetCategoryOptions, listExpenses, type ExpenseStatus,
} from "@/lib/finance-db";
import { fmtCny, pctCents, pctUsed, sumCents, toCents } from "@/lib/money";

export const metadata: Metadata = { title: "财务" };

const PAD = "24px clamp(18px, 3vw, 52px) 60px";
const CARD = { background: "white", borderRadius: 12, border: "1px solid var(--line)" } as const;

const STATUS_LABEL: Record<ExpenseStatus, string> = {
  pending: "待审批", approved: "已入账", rejected: "已驳回", cancelled: "已撤回",
};

/**
 * 财务页**不设门**：进得了项目就进得了这一页，看到什么由权限与上下文分层。
 *
 * 原因是这一页承载「填报销单」，而报销是全员能力。把整页拦在 budget@view 后面，
 * 等于「想让人报销就得先把全项目预算摊开给他」。
 *
 * 四层，由窄到宽：
 *   1. 科目表（只有名字与归属部门）      categories@view —— 基线，报销要选科目
 *   2. 我交的 ∪ 待我批的                 上下文，不需要键 —— POC 靠第二半看见要批的
 *   3. 全项目支出明细                    expenses@view
 *   4. 概览卡 + 各科目额度/已用/执行率    budget@view
 */
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

  const [canBudget, canAllExpenses, canCategories] = await Promise.all([
    hasEffectiveGrant(actor, id, "finance", "*", "budget", "view"),
    hasEffectiveGrant(actor, id, "finance", "*", "expenses", "view"),
    hasEffectiveGrant(actor, id, "finance", "*", "categories", "view"),
  ]);

  const [categories, options, expenses] = await Promise.all([
    canBudget ? listBudgetCategories(id) : Promise.resolve([]),
    // 有额度面时不必再查窄面——宽的已经包含名字
    !canBudget && canCategories ? listBudgetCategoryOptions(id) : Promise.resolve([]),
    canAllExpenses
      ? listExpenses(id)
      : listExpenses(id, { submittedBy: session.userId, pendingFor: session.userId }),
  ]);

  const budgetCents = sumCents(categories.map(c => c.amount));
  const spentCents = sumCents(categories.map(c => c.spent));
  const summary: [string, string][] = [
    [fmtCny(budgetCents), "总预算"],
    [fmtCny(spentCents), "已使用"],
    [fmtCny(budgetCents - spentCents), "可用余额"],
    [`${pctCents(spentCents, budgetCents)}%`, "预算执行率"],
  ];

  const pendingMine = expenses.filter(
    e => e.status === "pending" && e.currentApproverIds.includes(session.userId));

  const empty = (text: string, hint: string) => (
    <div style={{ padding: "36px 20px", textAlign: "center", color: "var(--muted)" }}>
      <p style={{ fontSize: 12, marginBottom: 6 }}>{text}</p>
      <p style={{ fontSize: 10 }}>{hint}</p>
    </div>
  );

  const expenseRow = (e: (typeof expenses)[number]) => (
    <div key={e.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, padding: "12px 0", borderTop: "1px solid var(--line)" }}>
      <span>
        <b style={{ display: "block", fontSize: 11, color: "var(--ink)" }}>{e.title}</b>
        <small style={{ color: "var(--muted)", fontSize: 9 }}>
          {e.categoryName ?? "未归类"} · {STATUS_LABEL[e.status]}
          {canAllExpenses && e.submitterName ? ` · ${e.submitterName}` : ""}
        </small>
      </span>
      <b style={{ color: "var(--stage)", fontSize: 11 }}>{fmtCny(toCents(e.amount))}</b>
    </div>
  );

  const twoUp = canBudget || canCategories;

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

      {/* 待我审批：单独一条横幅置顶。混在下面的列表里，POC 得自己从一堆单子里认出
          哪几笔在等他——那正是「阶梯把他算进去了但他不知道」的另一种形态。 */}
      {pendingMine.length > 0 && (
        <div style={{ ...CARD, borderColor: "var(--stage)", padding: "14px 18px", marginBottom: 16 }}>
          <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "var(--stage)" }}>
            待你审批 · {pendingMine.length} 笔
          </p>
          {pendingMine.map(expenseRow)}
        </div>
      )}

      <div style={{
        display: "grid",
        gridTemplateColumns: twoUp ? "minmax(0, 1.15fr) minmax(300px, .85fr)" : "minmax(0, 1fr)",
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
                    <div style={{ width: `${Math.min(100, pctUsed(item.spent, item.amount))}%`, height: "100%", borderRadius: 999, background: "var(--stage)" }} />
                  </div>
                </div>
              ))}
          </section>
        )}

        {/* 没有额度面但有科目面：只列名字。报销时要选科目，看得见名字就够了 */}
        {!canBudget && canCategories && (
          <section style={{ ...CARD, padding: 20 }}>
            <p style={{ margin: "0 0 16px", fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>预算科目</p>
            {options.length === 0
              ? empty("还没有预算科目", "报销时可以先不选科目，由审批人归类")
              : options.map(o => (
                <div key={o.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "12px 0", borderTop: "1px solid var(--line)", fontSize: 11 }}>
                  <b style={{ color: "var(--ink)" }}>{o.name}</b>
                  <span style={{ color: "var(--muted)" }}>{o.deptName ?? "—"}</span>
                </div>
              ))}
          </section>
        )}

        <section style={{ ...CARD, padding: 20 }}>
          <p style={{ margin: "0 0 16px", fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>
            {canAllExpenses ? "近期支出" : "我的报销"}
          </p>
          {expenses.length === 0
            ? empty(canAllExpenses ? "还没有支出记录" : "你还没有提交过报销",
                    "提交后会按审批阶梯逐级流转")
            : expenses.slice(0, 12).map(expenseRow)}
        </section>
      </div>
    </div>
  );
}
