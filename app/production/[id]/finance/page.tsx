import type { Metadata } from "next";
import Link from "next/link";
import PageHeader, { SECONDARY_BTN } from "@/components/ui/PageHeader";
import {
  ExpenseAddDocumentButton, ExpenseApprovalActions, ExpenseCreateButton, ExpenseDetailButton,
  ExpenseDocumentLinks,
  type ExpenseCategoryOption,
} from "@/components/ops/FinanceExpenseActions";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/account/session";
import { getProductionName } from "@/lib/production/production-db";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { canAccessNode } from "@/lib/perm/grant-template";
import {
  listBudgetCategories, listBudgetCategoryOptions, listExpenses, type ExpenseStatus,
} from "@/lib/ops/finance-db";
import { fmtCny, pctUsed, sumCents, toCents } from "@/lib/money";
import responsive from "@/components/ops/responsive.module.css";
import PageActivationGate from "@/components/perm/PageActivationGate";

export const metadata: Metadata = { title: "财务" };

const PAD = "24px clamp(18px, 3vw, 52px) 60px";
const CARD = { background: "white", borderRadius: 12, border: "1px solid var(--line)" } as const;

const STATUS_LABEL: Record<ExpenseStatus, string> = {
  draft: "草稿", pending: "待审批", approved: "已批准", rejected: "已驳回", withdrawn: "已撤回",
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

  const [canBudget, canAllExpenses, canCategories, canCreateExpense, categoryConfig, budgetConfig] = await Promise.all([
    hasEffectiveGrant(actor, id, "finance", "*", "budget", "view"),
    hasEffectiveGrant(actor, id, "finance", "*", "expenses", "view"),
    hasEffectiveGrant(actor, id, "finance", "*", "categories", "view"),
    hasEffectiveGrant(actor, id, "finance", "*", "expenses", "create"),
    canAccessNode(actor, id, "finance", "*", "categories", "edit"),
    canAccessNode(actor, id, "finance", "*", "budget", "edit"),
  ]);
  const canFinanceConfig = categoryConfig.allowed || categoryConfig.reason === "needs_self_confirm"
    || budgetConfig.allowed || budgetConfig.reason === "needs_self_confirm";

  const [categories, options, expenses] = await Promise.all([
    canBudget ? listBudgetCategories(id) : Promise.resolve([]),
    // 有额度面时不必再查窄面——宽的已经包含名字
    !canBudget && canCategories ? listBudgetCategoryOptions(id) : Promise.resolve([]),
    canAllExpenses
      ? listExpenses(id)
      : listExpenses(id, { submittedBy: session.userId, pendingFor: session.userId }),
  ]);

  const budgetCents = sumCents(categories.flatMap(c => c.amount === null ? [] : [c.amount]));
  const spentCents = sumCents(categories.map(c => c.spent));
  const summary: [string, string][] = [
    [fmtCny(budgetCents), "已设置额度"],
    [fmtCny(spentCents), "实际支出"],
    [String(categories.filter(c => c.amount === null).length), "无上限预算项"],
    [String(categories.filter(c => c.amount !== null && toCents(c.spent) > toCents(c.amount)).length), "超预算项"],
  ];

  const pendingMine = expenses.filter(
    e => e.status === "pending" && e.currentApproverIds.includes(session.userId));

  const empty = (text: string, hint: string) => (
    <div style={{ padding: "36px 20px", textAlign: "center", color: "var(--muted)" }}>
      <p style={{ fontSize: 12, marginBottom: 6 }}>{text}</p>
      <p style={{ fontSize: 10 }}>{hint}</p>
    </div>
  );

  const expenseRow = (e: (typeof expenses)[number], approval = false) => (
    <div key={e.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, padding: "12px 0", borderTop: "1px solid var(--line)" }}>
      <span>
        <b style={{ display: "block", fontSize: 11, color: "var(--ink)" }}>{e.title}</b>
        <small style={{ color: "var(--muted)", fontSize: 9 }}>
          {e.categoryName ?? "未归类"} · {STATUS_LABEL[e.status]}
          {(canAllExpenses || approval) && e.submitterName ? ` · ${e.submitterName}` : ""}
        </small>
        <small style={{ display: "block", marginTop: 4, color: e.invoiceState === "pending" ? "#b45309" : "var(--muted)", fontSize: 9 }}>
          {e.invoiceState === "provided" && `已附发票 · ${e.documents.length} 份凭证`}
          {e.invoiceState === "pending" && `待补发票${e.documents.length > 0 ? ` · 已有 ${e.documents.length} 份其他凭证` : ""}`}
          {e.invoiceState === "waived" && `无需发票 · ${e.invoiceWaiverReason}`}
          {e.invoiceState === "legacy" && "历史报销未记录发票要求"}
        </small>
        <ExpenseDocumentLinks productionId={id} expenseId={e.id} documents={e.documents} />
        {e.invoiceState === "pending"
          && e.submittedBy === session.userId
          && (e.status === "pending" || e.status === "approved") && (
          <ExpenseAddDocumentButton productionId={id} expenseId={e.id} mutationSeq={e.mutationSeq} invoiceOnly />
        )}
        {approval && e.note && (
          <small style={{ display: "block", marginTop: 5, color: "var(--muted)", fontSize: 10, lineHeight: 1.5 }}>
            {e.note}
          </small>
        )}
      </span>
      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
        <b style={{ color: "var(--stage)", fontSize: 11 }}>
          {e.amount === null ? "金额未填写" : fmtCny(toCents(e.amount))}
        </b>
        {approval && !access.isArchived && (
          <ExpenseApprovalActions
            productionId={id}
            expenseId={e.id}
            canFinalize={e.canFinalize}
            mutationSeq={e.mutationSeq}
          />
        )}
        <ExpenseDetailButton
          productionId={id}
          expenseId={e.id}
          actorId={session.userId}
          categories={expenseCategoryOptions}
          archived={access.isArchived}
        />
      </span>
    </div>
  );

  const twoUp = canBudget || canCategories;
  const expenseCategoryOptions: ExpenseCategoryOption[] = canBudget
    ? categories.map(({ id: categoryId, name: categoryName, deptName }) => ({ id: categoryId, name: categoryName, deptName }))
    : options;

  return (
    <div style={{ padding: PAD, minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader
        eyebrow="Finance"
        title="财务"
        side="stage"
        actions={<>
          {canFinanceConfig && <Link href={`/production/${id}/admin/finance`} style={SECONDARY_BTN}>管理预算</Link>}
          {canCreateExpense && !access.isArchived && <ExpenseCreateButton productionId={id} categories={expenseCategoryOptions} />}
        </>}
      />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>预算 · 支出 · 关联</p>
      </div>

      {canBudget && (
        <div className={responsive.metricGrid}>
          {summary.map(([value, label]) => (
            <div key={label} className={responsive.metricCard}>
              <strong className={responsive.metricValue}>{value}</strong>
              <span className={responsive.metricLabel}>{label}</span>
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
          {pendingMine.map(e => expenseRow(e, true))}
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
                    <span style={{ color: item.amount !== null && toCents(item.spent) > toCents(item.amount) ? "#a33" : "var(--muted)" }}>
                      {fmtCny(toCents(item.spent))} / {item.amount === null ? "无上限" : fmtCny(toCents(item.amount))}
                      {item.amount !== null && toCents(item.spent) > toCents(item.amount)
                        ? ` · 超出 ${fmtCny(toCents(item.spent) - toCents(item.amount))}` : ""}
                    </span>
                  </div>
                  <div style={{ height: 6, marginTop: 9, borderRadius: 999, background: "var(--surface-2)", overflow: "hidden" }}>
                    <div style={{ width: `${item.amount === null ? 0 : Math.min(100, pctUsed(item.spent, item.amount))}%`, height: "100%", borderRadius: 999, background: "var(--stage)" }} />
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
            : expenses.slice(0, 12).map(e => expenseRow(e))}
        </section>
      </div>
      <PageActivationGate productionId={id} scope="finance" />
    </div>
  );
}
