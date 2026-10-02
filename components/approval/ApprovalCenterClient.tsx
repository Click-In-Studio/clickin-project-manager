"use client";

import { useCallback, useEffect, useState } from "react";
import PageHeader, { PRIMARY_BTN } from "@/components/ui/PageHeader";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import styles from "@/components/ui/my-pages.module.css";
import { BASE_PATH } from "@/lib/base-path";
import { formatMoney, isCurrencyCode } from "@/lib/money";
import type { AccessRequestFlowView } from "@/lib/approval/access-request-db";
import type {
  ApprovalCenterBusinessType,
  ApprovalCenterItem,
  ApprovalCenterPage,
  ApprovalCenterSort,
  ApprovalCenterStatus,
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

const TIME_RANGES = [
  { id: "all", label: "全部时间" },
  { id: "7d", label: "近 7 天", days: 7 },
  { id: "30d", label: "近 30 天", days: 30 },
  { id: "90d", label: "近 90 天", days: 90 },
] as const;

type TimeRange = (typeof TIME_RANGES)[number]["id"];
type MobileLevel = "queues" | "items" | "detail";

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
        <span className={`${styles.badge} ${detail.status === "approved" ? styles.badgeGreen
          : detail.status === "rejected" ? styles.badgeRed : styles.badgeAmber}`}>
          {EXPENSE_STATUS_LABEL[detail.status]}
        </span>
        <span className={styles.approvalDetailType}>费用报销</span>
      </div>
      <h2 className={styles.approvalDetailTitle}>{detail.title}</h2>
      <dl className={styles.approvalDetailFields}>
        <div><dt>申请人</dt><dd>{detail.submitterName ?? "项目成员"}</dd></div>
        <div><dt>金额</dt><dd>{detail.amount && isCurrencyCode(detail.currency)
          ? formatMoney(detail.amount, detail.currency) : "尚未填写"}</dd></div>
        <div><dt>费用科目</dt><dd>{detail.categoryName ?? "未归类"}</dd></div>
        <div><dt>当前节点</dt><dd>{detail.currentStage
          ? EXPENSE_STAGE_LABEL[detail.currentStage] ?? detail.currentStage
          : detail.status === "pending" ? "等待流程信息" : "流程已结束"}</dd></div>
      </dl>
      {detail.note && <section className={styles.approvalDetailSection}>
        <small>报销说明</small>
        <p>{detail.note}</p>
      </section>}
      <ExpenseDocumentLinks productionId={productionId} expenseId={detail.id} documents={detail.documents} />
      <section className={styles.approvalDetailSection}>
        <h3>处理记录</h3>
        {detail.events.map(event => (
          <p key={event.id} className={styles.approvalDetailEvent}>
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
  const [status, setStatus] = useState<"all" | ApprovalCenterStatus>("all");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [sort, setSort] = useState<ApprovalCenterSort>("oldest");
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [requestView, setRequestView] = useState<AccessRequestFlowView | null>(null);
  const [expense, setExpense] = useState<ExpenseDetailView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [acting, setActing] = useState<ActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mobileLevel, setMobileLevel] = useState<MobileLevel>("queues");

  const loadItems = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const makeUrl = () => {
        const params = new URLSearchParams({ view, limit: "100" });
        if (businessType !== "all") params.set("type", businessType);
        if (query) params.set("q", query);
        if (status !== "all") params.set("status", status);
        const range = TIME_RANGES.find(option => option.id === timeRange);
        if (range && "days" in range) {
          params.set("from", new Date(Date.now() - range.days * 24 * 60 * 60 * 1000).toISOString());
        }
        params.set("sort", sort);
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
  }, [businessType, productionId, query, sort, status, timeRange, view]);

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

  useEffect(() => {
    if (!selection && mobileLevel === "detail") setMobileLevel("items");
  }, [mobileLevel, selection]);

  function chooseItem(item: ApprovalCenterItem) {
    setActionError(null);
    setSelection({ kind: item.source === "approval_request" ? "request" : "expense", item });
    setMobileLevel("detail");
  }

  function chooseView(nextView: ApprovalCenterView, advanceMobile = false) {
    setView(nextView);
    setSort(nextView === "pending" ? "oldest" : "newest");
    setSelection(null);
    if (advanceMobile) setMobileLevel("items");
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
  const visibleTypes = TYPES.filter(option => option.id === "all"
    || typeCounts[option.id]
    || option.id === businessType);
  const summaryItems = [
    [String(viewCounts.pending ?? 0), "待我处理", "需要你的决定"],
    [String(viewCounts.processed ?? 0), "我已处理", "保留经办记录"],
    [String(viewCounts.submitted ?? 0), "我的申请", "查看申请进度"],
  ];
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
    <RequestForm productionId={productionId} onSubmitted={() => {
      setSelection(null); setMobileLevel("items"); void loadItems();
    }} onClose={() => { setSelection(null); setMobileLevel("items"); }} />
  ) : null;

  const categoryButtons = (
    <div className={styles.approvalCenterCategoryList}>
      {visibleTypes.map(option => <button key={option.id} type="button"
        aria-pressed={businessType === option.id}
        onClick={() => { setBusinessType(option.id); setSelection(null); }}>
        <span>{option.label}</span>
        <small>{option.id === "all" ? allTypeCount : typeCounts[option.id] ?? 0}</small>
      </button>)}
    </div>
  );

  const filters = (
    <div className={styles.approvalCenterFilters}>
      <form className={styles.approvalCenterSearch}
        onSubmit={event => { event.preventDefault(); setQuery(searchDraft.trim()); }}>
        <input aria-label="搜索审批" value={searchDraft} onChange={event => setSearchDraft(event.target.value)}
          placeholder="搜索申请人、标题或事由" maxLength={100} />
        <button type="submit">搜索</button>
        {query && <button type="button" onClick={() => { setSearchDraft(""); setQuery(""); }}>清除</button>}
      </form>
      <div className={styles.approvalCenterFilterRow}>
        <label>时间
          <OverflowSafeSelect aria-label="时间筛选" value={timeRange}
            onChange={event => setTimeRange(event.target.value as TimeRange)}>
            {TIME_RANGES.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </OverflowSafeSelect>
        </label>
        <label>状态
          <OverflowSafeSelect aria-label="状态筛选" value={status}
            onChange={event => setStatus(event.target.value as "all" | ApprovalCenterStatus)}>
            <option value="all">全部状态</option>
            <option value="pending">处理中</option>
            <option value="approved">已批准</option>
            <option value="rejected">已拒绝</option>
            <option value="cancelled">已撤回</option>
          </OverflowSafeSelect>
        </label>
        <label>排序
          <OverflowSafeSelect aria-label="排序方式" value={sort}
            onChange={event => setSort(event.target.value as ApprovalCenterSort)}>
            <option value="oldest">最早优先</option>
            <option value="newest">最新优先</option>
          </OverflowSafeSelect>
        </label>
      </div>
    </div>
  );

  const list = (
    <div className={styles.approvalCenterList} aria-label="审批列表">
      {loading ? <p className={styles.approvalCenterEmpty}>加载中…</p>
        : listError ? <p className={styles.approvalDetailError} role="alert">{listError}</p>
          : items.length === 0 ? <p className={styles.approvalCenterEmpty}>{currentEmpty}</p> : items.map(item => (
            <button key={item.id} type="button" onClick={() => chooseItem(item)}
              aria-current={selection && selection.kind !== "form" && selection.item.id === item.id ? "true" : undefined}>
              <span className={styles.approvalCenterListHeader}>
                <b className={styles.approvalCenterListTitle}>{itemTitle(item)}</b>
                <i>{item.businessType === "expense" ? "费用" : "权限"}</i>
              </span>
              <small className={styles.approvalCenterListMeta}>{item.applicant.name} · {STATUS_LABEL[item.status]} · {fmtDate(item.createdAt)}</small>
              {item.note && <span className={styles.approvalCenterListNote}>{item.note}</span>}
            </button>
          ))}
    </div>
  );

  return (
    <div className={`${styles.workspace} ${styles.approvalCenterWorkspace}`}>
      <PageHeader eyebrow={productionName} title="审批中心" side="stage"
        actions={!archived ? <button type="button" style={PRIMARY_BTN} onClick={() => {
          setSelection({ kind: "form" });
          setMobileLevel("detail");
        }}>申请资源权限</button> : null} />

      <div className={styles.approvalCenterSummary}>
        {summaryItems.map(([num, label, hint]) => <div key={label}>
          <span>{num}</span><p><b>{label}</b><small>{hint}</small></p>
        </div>)}
      </div>

      <section className={`${styles.responsiveContentPanel} ${styles.approvalCenterPanel}`}>
        <div className={styles.desktopOnly}>
          <div className={styles.approvalCenterDesktopLayout}>
            <aside className={styles.approvalCenterNav} aria-label="审批中心导航">
              <h2>审批队列</h2>
              <div className={styles.approvalCenterQueueList}>
                {VIEWS.map(option => <button key={option.id} type="button"
                  aria-pressed={view === option.id} onClick={() => chooseView(option.id)}>
                  <span>{option.label}</span><small>{viewCounts[option.id] ?? 0}</small>
                </button>)}
              </div>
              <h2>业务分类</h2>
              {categoryButtons}
            </aside>
            <section className={styles.approvalCenterMiddle} aria-label="审批列表">
              {filters}
              {list}
            </section>
            <section className={styles.approvalCenterDetailPane} aria-label="审批详情入口">
              {detail ?? <div className={styles.approvalCenterDetailPlaceholder}>
                <span>→</span><b>选择一条审批</b><p>在这里查看业务字段、处理记录和当前可执行操作。</p>
              </div>}
            </section>
          </div>
        </div>

        <div className={styles.mobileOnly}>
          {mobileLevel === "queues" && <nav className={styles.approvalCenterMobileQueues} aria-label="选择审批队列">
            <p>先选择要查看的审批队列</p>
            {VIEWS.map(option => <button key={option.id} type="button" onClick={() => chooseView(option.id, true)}>
              <span><b>{option.label}</b><small>{option.empty}</small></span>
              <em>{viewCounts[option.id] ?? 0} ›</em>
            </button>)}
          </nav>}
          {mobileLevel === "items" && <div className={styles.approvalCenterMobileItems}>
            <header><button type="button" onClick={() => setMobileLevel("queues")}>← 队列</button><b>{VIEWS.find(option => option.id === view)?.label}</b></header>
            <div className={styles.approvalCenterMobileTabs}>
              {VIEWS.map(option => <button key={option.id} type="button" aria-pressed={view === option.id}
                onClick={() => chooseView(option.id, true)}>{option.label}</button>)}
            </div>
            {categoryButtons}
            {filters}
            {list}
          </div>}
          {selection && mobileLevel === "detail" && <div className={styles.approvalDetailDrawer} role="dialog" aria-modal="true" aria-label="审批详情">
            <header className={styles.approvalDetailDrawerHeader}>
              <button type="button" onClick={() => { setSelection(null); setMobileLevel("items"); }}>← 返回</button><span>审批详情</span>
            </header>
            <div className={styles.approvalDetailDrawerBody}>{detail}</div>
          </div>}
        </div>
      </section>
    </div>
  );
}
