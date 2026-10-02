/**
 * 项目审批中心跨业务只读投影。
 *
 * 真相源仍是各业务表：资源访问来自 approval_request，费用来自 production_expense。
 * 成员退出与 Owner 转移尚无同形的持久参与事实，接入前分别由 #797 / #796 跟踪。
 * 这里不推进流程、不重算审批人，也不读取通知表。
 */
import { getPool } from "../pg";
import { isCurrencyCode, normalizeMoneyAmount } from "../money";
import type {
  ApprovalCenterItem,
  ApprovalCenterListParams,
  ApprovalCenterPage,
  ApprovalCenterStatus,
} from "./approval-center-types";
import {
  APPROVAL_CENTER_BUSINESS_TYPES,
  ApprovalCenterQueryError,
} from "./approval-center-types";

type ApprovalCenterRow = {
  source: "approval_request" | "expense";
  source_id: string;
  business_type: string;
  applicant_id: string;
  applicant_name: string;
  title: string;
  note: string | null;
  status: ApprovalCenterStatus;
  source_status: string;
  can_finalize_for_viewer: boolean;
  created_at: Date;
  resolved_at: Date | null;
  detail: ApprovalCenterItem["detail"];
  total_count: string;
};

type ApprovalCenterCursor = {
  createdAt: string;
  source: "approval_request" | "expense";
  sourceId: string;
  sort: ApprovalCenterListParams["sort"];
};

function encodeCursor(row: ApprovalCenterRow, sort: ApprovalCenterListParams["sort"]): string {
  const cursor: ApprovalCenterCursor = {
    createdAt: row.created_at.toISOString(),
    source: row.source,
    sourceId: row.source_id,
    sort,
  };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): ApprovalCenterCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ApprovalCenterCursor>;
    if (
      typeof parsed.createdAt !== "string"
      || Number.isNaN(new Date(parsed.createdAt).getTime())
      || (parsed.source !== "approval_request" && parsed.source !== "expense")
      || typeof parsed.sourceId !== "string"
      || !parsed.sourceId
      || (parsed.sort !== "newest" && parsed.sort !== "oldest")
    ) throw new Error("invalid cursor shape");
    return parsed as ApprovalCenterCursor;
  } catch {
    throw new ApprovalCenterQueryError("cursor 参数无效");
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function rowToItem(row: ApprovalCenterRow): ApprovalCenterItem {
  if (!(APPROVAL_CENTER_BUSINESS_TYPES as readonly string[]).includes(row.business_type)) {
    throw new Error(`unsupported approval center business type: ${row.business_type}`);
  }
  const detail = row.detail.kind === "expense" && isCurrencyCode(row.detail.currency)
    ? { ...row.detail, amount: normalizeMoneyAmount(row.detail.amount, row.detail.currency) }
    : row.detail;
  return {
    id: `${row.source}:${row.source_id}`,
    sourceId: row.source_id,
    source: row.source,
    businessType: row.business_type as ApprovalCenterItem["businessType"],
    applicant: { id: row.applicant_id, name: row.applicant_name },
    title: row.title,
    note: row.note,
    status: row.status,
    sourceStatus: row.source_status,
    canFinalizeForViewer: row.can_finalize_for_viewer,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    detail,
  };
}

const UNIFIED_APPROVAL_QUERY = `
  WITH unified AS (
    SELECT
      'approval_request'::text AS source,
      ar.id::text AS source_id,
      CASE ar.type
        WHEN 'atomic_permission' THEN 'resource_access'
        WHEN 'resource_access' THEN 'resource_access'
        ELSE '__unsupported__:' || ar.type
      END AS business_type,
      ar.production_id,
      ar.subject_id AS applicant_id,
      COALESCE(NULLIF(up.display_name, ''), NULLIF(up.name, ''), '成员') AS applicant_name,
      '权限申请'::text AS title,
      ar.note,
      CASE WHEN ar.status IN ('pending_supervisor', 'pending_resource') THEN 'pending' ELSE ar.status END AS status,
      ar.status AS source_status,
      CASE WHEN ar.status IN ('pending_supervisor', 'pending_resource')
                  AND ar.current_approver_ids @> ARRAY[$1]::uuid[]
           THEN COALESCE((ar.escalation_chain -> -1 ->> 'canFinalize')::boolean, true)
           ELSE false END AS can_finalize_for_viewer,
      ar.created_at,
      ar.resolved_at,
      jsonb_build_object(
        'kind', 'approval_request',
        'resourceType', ar.resource_type,
        'resourceId', ar.resource_id,
        'resourceSub', ar.resource_sub,
        'permissionLevel', ar.permission_level,
        'grantType', ar.grant_type,
        'requestedExpiresAt', ar.requested_expires_at
      ) AS detail,
      ar.current_approver_ids,
      ar.escalation_chain,
      ar.flow_snapshot,
      ar.subject_id = $1::uuid AS submitted_by_viewer,
      ar.status IN ('pending_supervisor', 'pending_resource')
        AND ar.current_approver_ids @> ARRAY[$1]::uuid[] AS pending_for_viewer,
      EXISTS (
        SELECT 1
          FROM jsonb_array_elements(ar.escalation_chain) AS entry
         WHERE entry ->> 'actorId' = $1::text
           AND entry ->> 'action' IN ('approved', 'rejected', 'escalated')
      ) AS processed_by_viewer,
      EXISTS (
        SELECT 1
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(ar.flow_snapshot -> 'nodes') = 'array'
                 THEN ar.flow_snapshot -> 'nodes' ELSE '[]'::jsonb END
          ) AS node
         WHERE CASE WHEN jsonb_typeof(node -> 'deliveredTo') = 'array'
                    THEN node -> 'deliveredTo' ELSE '[]'::jsonb END
               ? ($1::text)
      ) AS cc_for_viewer,
      concat_ws(
        ' ', up.display_name, up.name, ar.note, ar.resource_type, ar.resource_id,
        ar.resource_sub, '权限申请'
      ) AS search_text
    FROM approval_request ar
    LEFT JOIN user_profile up ON up.user_id = ar.subject_id
    WHERE ar.production_id = $2
      AND ar.type IN ('resource_access', 'atomic_permission')

    UNION ALL

    SELECT
      'expense'::text AS source,
      e.id::text AS source_id,
      'expense'::text AS business_type,
      e.production_id,
      e.submitted_by AS applicant_id,
      COALESCE(NULLIF(up.display_name, ''), NULLIF(up.name, ''), '成员') AS applicant_name,
      e.title,
      NULLIF(e.note, '') AS note,
      CASE WHEN e.status = 'withdrawn' THEN 'cancelled' ELSE e.status END AS status,
      e.status AS source_status,
      CASE WHEN e.status = 'pending' AND e.current_approver_ids @> ARRAY[$1]::uuid[]
           THEN COALESCE((e.escalation_chain -> -1 ->> 'canFinalize')::boolean, true)
           ELSE false END AS can_finalize_for_viewer,
      e.created_at,
      e.resolved_at,
      jsonb_build_object(
        'kind', 'expense',
        'categoryId', e.budget_item_id,
        'categoryName', c.name,
        'amount', e.amount::text,
        'currency', e.currency
      ) AS detail,
      e.current_approver_ids,
      e.escalation_chain,
      NULL::jsonb AS flow_snapshot,
      e.submitted_by = $1::uuid AS submitted_by_viewer,
      e.status = 'pending'
        AND e.current_approver_ids @> ARRAY[$1]::uuid[] AS pending_for_viewer,
      EXISTS (
        SELECT 1
          FROM production_expense_event ev
         WHERE ev.expense_id = e.id
           AND ev.actor_id = $1::uuid
           AND ev.event_type IN ('approved', 'rejected', 'forwarded')
      ) AS processed_by_viewer,
      false AS cc_for_viewer,
      concat_ws(' ', up.display_name, up.name, e.title, e.note, c.name) AS search_text
    FROM production_expense e
    LEFT JOIN production_budget_item bi ON bi.id = e.budget_item_id
    LEFT JOIN production_expense_category c ON c.id = bi.category_id
    LEFT JOIN user_profile up ON up.user_id = e.submitted_by
    WHERE e.production_id = $2
      AND e.status <> 'draft'
  )`;

/**
 * 列出当前用户真实参与的审批实例。四个视图均从业务事实推导：
 * - pending: current_approver_ids
 * - processed: 各业务持久事件中当前用户的实际动作（权限申请仍读其链内事实）
 * - cc: flow_snapshot 的 deliveredTo（绝不读 user_notification）
 * - submitted: subject_id / submitted_by
 */
export async function listApprovalCenterItems(
  actorId: string,
  productionId: string,
  options: ApprovalCenterListParams,
): Promise<ApprovalCenterPage> {
  const direction = options.sort === "oldest" ? "ASC" : "DESC";
  const relation = {
    pending: "pending_for_viewer",
    processed: "processed_by_viewer",
    cc: "cc_for_viewer",
    submitted: "submitted_by_viewer",
  }[options.view];

  function buildFilter(includeRelation: boolean, includeBusinessTypes: boolean, includeCursor: boolean) {
    const params: unknown[] = [actorId, productionId];
    const where = includeRelation ? [relation] : [];
    if (includeBusinessTypes && options.businessTypes?.length) {
      where.push(`business_type = ANY($${params.push(options.businessTypes)}::text[])`);
    }
    if (options.statuses?.length) {
      where.push(`status = ANY($${params.push(options.statuses)}::text[])`);
    }
    if (options.from) where.push(`created_at >= $${params.push(options.from)}::timestamptz`);
    if (options.to) where.push(`created_at < $${params.push(options.to)}::timestamptz`);
    if (options.query) {
      where.push(`search_text ILIKE $${params.push(`%${escapeLike(options.query)}%`)} ESCAPE '\\'`);
    }
    if (includeCursor && options.cursor) {
      const cursor = decodeCursor(options.cursor);
      if (cursor.sort !== options.sort) throw new ApprovalCenterQueryError("cursor 与 sort 不匹配");
      const createdAtParam = params.push(cursor.createdAt);
      const sourceParam = params.push(cursor.source);
      const sourceIdParam = params.push(cursor.sourceId);
      const timeOperator = direction === "ASC" ? ">" : "<";
      where.push(`(
        created_at ${timeOperator} $${createdAtParam}::timestamptz
        OR (created_at = $${createdAtParam}::timestamptz
            AND (source, source_id) > ($${sourceParam}::text, $${sourceIdParam}::text))
      )`);
    }
    return { params, where };
  }

  const dataFilter = buildFilter(true, true, true);
  const countFilter = buildFilter(false, false, false);
  const countBusinessFilter = options.businessTypes?.length
    ? `business_type = ANY($${countFilter.params.push(options.businessTypes)}::text[])`
    : "true";
  const [result, countResult] = await Promise.all([
    getPool().query<ApprovalCenterRow>(
    `${UNIFIED_APPROVAL_QUERY}
     SELECT source, source_id, business_type,
            applicant_id, applicant_name, title, note, status, source_status,
            can_finalize_for_viewer, created_at, resolved_at, detail,
            count(*) OVER() AS total_count
       FROM unified
      WHERE ${dataFilter.where.join(" AND ")}
      ORDER BY created_at ${direction}, source ASC, source_id ASC
      LIMIT $${dataFilter.params.push(options.limit + 1)}`,
      dataFilter.params,
    ),
    getPool().query<{
      pending: string; processed: string; cc: string; submitted: string;
      resource_access: string; expense: string;
    }>(
      `${UNIFIED_APPROVAL_QUERY}
       SELECT
         count(*) FILTER (WHERE pending_for_viewer AND ${countBusinessFilter}) AS pending,
         count(*) FILTER (WHERE processed_by_viewer AND ${countBusinessFilter}) AS processed,
         count(*) FILTER (WHERE cc_for_viewer AND ${countBusinessFilter}) AS cc,
         count(*) FILTER (WHERE submitted_by_viewer AND ${countBusinessFilter}) AS submitted,
         count(*) FILTER (WHERE ${relation} AND business_type = 'resource_access') AS resource_access,
         count(*) FILTER (WHERE ${relation} AND business_type = 'expense') AS expense
         FROM unified
        WHERE ${countFilter.where.length > 0 ? countFilter.where.join(" AND ") : "true"}`,
      countFilter.params,
    ),
  ]);

  const hasMore = result.rows.length > options.limit;
  const pageRows = hasMore ? result.rows.slice(0, options.limit) : result.rows;
  const counts = countResult.rows[0];
  return {
    items: pageRows.map(rowToItem),
    total: pageRows.length > 0 ? Number(pageRows[0].total_count) : 0,
    viewCounts: {
      pending: Number(counts?.pending ?? 0),
      processed: Number(counts?.processed ?? 0),
      cc: Number(counts?.cc ?? 0),
      submitted: Number(counts?.submitted ?? 0),
    },
    businessTypeCounts: {
      resource_access: Number(counts?.resource_access ?? 0),
      expense: Number(counts?.expense ?? 0),
    },
    nextCursor: hasMore ? encodeCursor(pageRows[pageRows.length - 1], options.sort) : null,
  };
}
