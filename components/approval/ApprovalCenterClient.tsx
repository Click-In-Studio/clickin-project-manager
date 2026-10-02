"use client";

import { useCallback, useEffect, useState } from "react";
import PageHeader, { PRIMARY_BTN } from "@/components/ui/PageHeader";
import styles from "@/components/ui/my-pages.module.css";
import { BASE_PATH } from "@/lib/base-path";
import { formatMoney, isCurrencyCode } from "@/lib/money";
import type { AccessRequestFlowView } from "@/lib/approval/access-request-db";
import type {
  ApprovalCenterBusinessType,
  ApprovalCenterItem,
  ApprovalCenterPage,
  ApprovalCenterView,
} from "@/lib/approval/approval-center-types";
import { permissionLevelLabel, resourceTypeLabel } from "@/lib/perm/permission-labels";
import {
  RequestDetail,
  RequestForm,
  type ActionKind,
} from "@/components/approval/AccessRequestsClient";
import {
  ExpenseApprovalActions,
  ExpenseDocumentLinks,
  type ExpenseDetailView,
} from "@/components/ops/FinanceExpenseActions";

const VIEWS: { id: ApprovalCenterView; label: string; empty: string }[] = [
  { id: "pending", label: "待我处理", empty: "当前没有需要你处理的审批" },
  { id: "processed", label: "我已处理", empty: "暂无已处理记录" },
  { id: "cc", label: "抄送我的", empty: "暂无抄送记录" },
  { id: "submitted", label: "我的申请", empty: "暂无申请记录" },
];

const TYPES: { id: "all" | ApprovalCenterBusinessType; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "resource_access", label: "权限申请" },
  { id: "expense", label: "费用报销" },
];

const STATUS_LABEL: Record<ApprovalCenterItem["status"], string> = {
  pending: "处理中", approved: "已批准", rejected: "已拒绝", cancelled: "已撤回",
};

const EXPENSE_STATUS_LABEL: Record<ExpenseDetailView["status"], string> = {
  draft: "草稿", pending: "待审批", approved: "已批准", rejected: "已驳回", withdrawn: "已撤回",
};

const EXPENSE_STAGE_LABEL: Record<string, string> = {
  supervisor: "直属上级", holder: "资源负责人", dept_poc: "归属部门负责人",
  ancestor_poc: "上级部门负责人", producer: "制作人", owner: "项目所有者",
};

const EXPENSE_EVENT_LABEL: Record<string, string> = {
  submitted: "提交审批", forwarded: "向上转交", approved: "批准报销", rejected: "驳回报销",
  withdrawn: "撤回报销", reopened: "重新进入编辑", reclassified: "调整预算项并重新路由",
  document_added: "补充凭证", post_approval_document_added: "审批后补充发票",
};

function fmtDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function itemTitle(item: ApprovalCenterItem) {
  if (item.detail.kind === "expense") return item.title;
  return `${item.detail.resourceType ? resourceTypeLabel(item.detail.resourceType) : "权限"} · ${
    item.detail.permissionLevel ? permissionLevelLabel(item.detail.permissionLevel) : "申请"
  }`;
}

function ExpenseDetail({
  productionId, actorId, detail, loading, error, archived, onUpdated,
}: {
  productionId: string;
  actorId: string;
  detail: ExpenseDetailView | null;
  loading: boolean;
  error: string | null;
  archived: boolean;
  onUpdated: () => void;
}) {
  if (loading) return <p className={styles.approvalDetailLoading}>正在核对报销详情与可执行操作…</p>;
  if (error) return <p className={styles.approvalDetailError}>{error}</p>;
  if (!detail) return null;
  const canAct = detail.status === "pending" && detail.currentApproverIds.includes(actorId) && !archived;
  return (
    <article className={styles.approvalDetail} data-approval-detail>
      <div className={styles.approvalDetailBadges}>
        <span className={detail.status === "approved" ? styles.badgeGreen
          : detail.status === "rejected" ? styles.badgeRed : styles.badgeAmber}>
          {EXPENSE_STATUS_LABEL[detail.status]}
        </span>
        <span style={{ fontSize: 11, color: "var(--muted)" }}>费用报销</span>
      </div>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: "var(--ink)" }}>{detail.title}</h2>
      <dl className={styles.approvalDetailFields}>
        <div><dt>申请人</dt><dd>{detail.submitterName ?? "项目成员"}</dd></div>
        <div><dt>金额</dt><dd>{detail.amount && isCurrencyCode(detail.currency)
          ? formatMoney(detail.amount, detail.currency) : "尚未填写"}</dd></div>
        <div><dt>费用科目</dt><dd>{detail.categoryName ?? "未归类"}</dd></div>
        <div><dt>当前节点</dt><dd>{detail.currentStage
          ? EXPENSE_STAGE_LABEL[detail.currentStage] ?? detail.currentStage
          : detail.status === "pending" ? "等待流程信息" : "流程已结束"}</dd></div>
      </dl>
      {detail.note && <section style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}>
        <small style={{ color: "var(--muted)" }}>报销说明</small>
        <p style={{ lineHeight: 1.6 }}>{detail.note}</p>
      </section>}
      <ExpenseDocumentLinks productionId={productionId} expenseId={detail.id} documents={detail.documents} />
      <section style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}>
        <h3 style={{ fontSize: 12 }}>处理记录</h3>
        {detail.events.map(event => (
          <p key={event.id} style={{ fontSize: 11, color: "var(--muted)" }}>
            {event.actorName ?? "系统"} · {EXPENSE_EVENT_LABEL[event.type] ?? event.type} · {fmtDate(event.createdAt)}
            {event.comment ? ` · ${event.comment}` : ""}
          </p>
        ))}
      </section>
      {canAct && <ExpenseApprovalActions
        productionId={productionId}
        expenseId={detail.id}
        canFinalize={detail.canFinalize}
        mutationSeq={detail.mutationSeq}
        currentBudgetItemId={detail.categoryId}
        categories={[]}
        onUpdated={onUpdated}
      />}
    </article>
  );
}

type Selection = { kind: "request"; item: ApprovalCenterItem }
  | { kind: "expense"; item: ApprovalCenterItem }
  | { kind: "form" }
  | null;

export default function ApprovalCenterClient({
  productionId, productionName, actorId, archived,
}: {
  productionId: string;
  productionName: string;
  actorId: string;
  archived: boolean;
}) {
  const [view, setView] = useState<ApprovalCenterView>("pending");
  const [businessType, setBusinessType] = useState<"all" | ApprovalCenterBusinessType>("all");
  const [items, setItems] = useState<ApprovalCenterItem[]>([]);
  const [viewCounts, setViewCounts] = useState<Partial<Record<ApprovalCenterView, number>>>({});
  const [typeCounts, setTypeCounts] = useState<Partial<Record<ApprovalCenterBusinessType, number>>>({});
  const [allTypeCount, setAllTypeCount] = useState(0);
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [requestView, setRequestView] = useState<AccessRequestFlowView | null>(null);
  const [expense, setExpense] = useState<ExpenseDetailView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [acting, setActing] = useState<ActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const makeUrl = () => {
        const params = new URLSearchParams({ view, limit: "100" });
        if (businessType !== "all") params.set("type", businessType);
        if (query) params.set("q", query);
        return `${BASE_PATH}/api/production/${productionId}/approval-items?${params}`;
      };
      const response = await fetch(makeUrl());
      const data = await response.json().catch(() => ({})) as ApprovalCenterPage & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "审批列表加载失败");
      setItems(data.items);
      setViewCounts(data.viewCounts);
      setAllTypeCount(data.businessTypeCounts.resource_access + data.businessTypeCounts.expense);
      setTypeCounts(data.businessTypeCounts);
      setSelection(current => current && current.kind !== "form"
        && !data.items.some(item => item.id === current.item.id) ? null : current);
    } catch (loadError) {
      setListError(loadError instanceof Error ? loadError.message : "审批列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [businessType, productionId, query, view]);

  useEffect(() => { void loadItems(); }, [loadItems]);

  const loadSelectedDetail = useCallback(async (selected: Exclude<Selection, { kind: "form" } | null>) => {
    setDetailLoading(true);
    setDetailError(null);
    setRequestView(null);
    setExpense(null);
    try {
      const path = selected.kind === "request"
        ? `/api/production/${productionId}/access-requests/${selected.item.sourceId}/flow`
        : `/api/production/${productionId}/finance/expenses/${selected.item.sourceId}`;
      const response = await fetch(`${BASE_PATH}${path}`);
      const data = await response.json().catch(() => ({})) as AccessRequestFlowView & {
        expense?: ExpenseDetailView; error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "审批详情加载失败");
      if (selected.kind === "request") setRequestView(data);
      else setExpense(data.expense ?? null);
    } catch (loadError) {
      setDetailError(loadError instanceof Error ? loadError.message : "审批详情加载失败");
    } finally {
      setDetailLoading(false);
    }
  }, [productionId]);

  useEffect(() => {
    if (selection && selection.kind !== "form") void loadSelectedDetail(selection);
  }, [loadSelectedDetail, selection]);

  function chooseItem(item: ApprovalCenterItem) {
    setActionError(null);
    setSelection({ kind: item.source === "approval_request" ? "request" : "expense", item });
  }

  async function runRequestAction(kind: ActionKind) {
    if (selection?.kind !== "request" || acting) return;
    setActing(kind);
    setActionError(null);
    try {
      const response = await fetch(
        `${BASE_PATH}/api/production/${productionId}/access-requests/${selection.item.sourceId}/${kind}`,
        { method: "POST" },
      );
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "审批处理失败");
      await Promise.all([loadItems(), loadSelectedDetail(selection)]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "审批处理失败");
      await loadSelectedDetail(selection);
    } finally {
      setActing(null);
    }
  }

  const currentEmpty = VIEWS.find(item => item.id === view)?.empty ?? "暂无审批";
  const detail = selection?.kind === "request" ? (
    requestView ? <RequestDetail
      req={requestView.request}
      view={requestView}
      loading={detailLoading}
      loadError={detailError}
      actionError={actionError}
      actionLocked={acting !== null}
      acting={acting}
      onApprove={() => void runRequestAction("approve")}
      onReject={() => void runRequestAction("reject")}
      onEscalate={() => void runRequestAction("escalate")}
      onCancel={() => void runRequestAction("cancel")}
    /> : <p className={detailError ? styles.approvalDetailError : styles.approvalDetailLoading}>
      {detailError ?? "正在核对流程与可执行操作…"}
    </p>
  ) : selection?.kind === "expense" ? (
    <ExpenseDetail productionId={productionId} actorId={actorId} detail={expense}
      loading={detailLoading} error={detailError} archived={archived}
      onUpdated={() => void Promise.all([loadItems(), loadSelectedDetail(selection)])} />
  ) : selection?.kind === "form" ? (
    <RequestForm productionId={productionId} onSubmitted={() => { setSelection(null); void loadItems(); }}
      onClose={() => setSelection(null)} />
  ) : null;

  return (
    <div className={styles.workspace} style={{ minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow={productionName} title="审批中心" side="stage"
        actions={!archived ? <button type="button" style={PRIMARY_BTN}
          onClick={() => setSelection({ kind: "form" })}>申请资源权限</button> : null} />

      <section className={styles.responsiveContentPanel} style={{
        background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13,
        padding: 22, display: "flex", flexDirection: "column",
      }}>
        <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--line)", overflowX: "auto" }}>
          {VIEWS.map(option => <button key={option.id} type="button"
            onClick={() => { setView(option.id); setSelection(null); }} style={{
              background: "none", border: "none", whiteSpace: "nowrap", padding: "9px 14px",
              borderBottom: view === option.id ? "2px solid var(--ink)" : "2px solid transparent",
              color: view === option.id ? "var(--ink)" : "var(--muted)",
              fontWeight: view === option.id ? 650 : 400, cursor: "pointer",
            }}>{option.label}{viewCounts[option.id] ? ` (${viewCounts[option.id]})` : ""}</button>)}
        </div>
        <div style={{ display: "flex", gap: 8, padding: "14px 0", overflowX: "auto" }}>
          {TYPES.map(option => <button key={option.id} type="button"
            onClick={() => { setBusinessType(option.id); setSelection(null); }} style={{
              border: "1px solid var(--line)", borderRadius: 999, padding: "5px 12px", whiteSpace: "nowrap",
              background: businessType === option.id ? "var(--ink)" : "transparent",
              color: businessType === option.id ? "white" : "var(--muted)", cursor: "pointer",
            }}>{option.label}{option.id === "all"
              ? allTypeCount > 0 ? ` (${allTypeCount})` : ""
              : typeCounts[option.id] ? ` (${typeCounts[option.id]})` : ""}</button>)}
        </div>
        <form onSubmit={event => { event.preventDefault(); setQuery(searchDraft.trim()); }} style={{
          display: "flex", gap: 8, marginBottom: 14,
        }}>
          <input aria-label="搜索审批" value={searchDraft} onChange={event => setSearchDraft(event.target.value)}
            placeholder="搜索申请人、标题或事由" maxLength={100} style={{
              flex: 1, minWidth: 0, border: "1px solid var(--line)", borderRadius: 8,
              background: "var(--paper)", padding: "8px 10px",
            }} />
          <button type="submit">搜索</button>
          {query && <button type="button" onClick={() => { setSearchDraft(""); setQuery(""); }}>清除</button>}
        </form>

        <div className={styles.desktopOnly} style={{ flex: 1, minHeight: 0 }}>
          <div className={styles.splitLayout} style={{ height: "100%", minHeight: 0 }}>
            <div className={`${styles.splitPane} ${styles.splitList}`}>
              {loading ? <p>加载中…</p> : listError ? <p role="alert">{listError}</p>
                : items.length === 0 ? <p>{currentEmpty}</p> : items.map(item => (
                  <button key={item.id} type="button" onClick={() => chooseItem(item)} style={{
                    width: "100%", padding: "12px 14px", textAlign: "left", borderRadius: 10,
                    border: selection && selection.kind !== "form" && selection.item.id === item.id
                      ? "1px solid var(--ink)" : "1px solid transparent",
                    background: "transparent", cursor: "pointer",
                  }}>
                    <b style={{ display: "block", fontSize: 13 }}>{itemTitle(item)}</b>
                    <small style={{ color: "var(--muted)" }}>{item.applicant.name} · {STATUS_LABEL[item.status]} · {fmtDate(item.createdAt)}</small>
                  </button>
                ))}
            </div>
            <div className={`${styles.splitPane} ${styles.splitDetail}`}>
              {detail ?? <div style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)" }}>选择左侧审批查看详情</div>}
            </div>
          </div>
        </div>

        <div className={styles.mobileOnly}>
          {loading ? <div className={styles.emptyState}>加载中…</div>
            : listError ? <div className={styles.emptyState}>{listError}</div>
              : items.length === 0 ? <div className={styles.emptyState}>{currentEmpty}</div>
                : <div className={styles.mobileCardList}>{items.map(item => (
                  <div key={item.id} className={styles.mobileCard}>
                    <button className={styles.mobileCardBtn} type="button" onClick={() => chooseItem(item)}>
                      <div className={styles.mobileCardHeader}><span>{item.applicant.name}</span><span>{fmtDate(item.createdAt)}</span></div>
                      <p className={styles.mobileCardTitle}>{itemTitle(item)}</p>
                      <p className={styles.mobileCardPreview}>{STATUS_LABEL[item.status]}{item.note ? ` · ${item.note}` : ""}</p>
                    </button>
                  </div>
                ))}</div>}
          {selection && <div className={styles.approvalDetailDrawer} role="dialog" aria-modal="true" aria-label="审批详情">
            <header className={styles.approvalDetailDrawerHeader}>
              <button type="button" onClick={() => setSelection(null)}>← 返回</button><span>审批详情</span>
            </header>
            <div className={styles.approvalDetailDrawerBody}>{detail}</div>
          </div>}
        </div>
      </section>
    </div>
  );
}
