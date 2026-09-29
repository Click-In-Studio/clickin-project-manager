/**
 * 审批中心的跨业务只读契约。
 *
 * 这个文件刻意不依赖 pg / Node API，后续 UI 可以只导入 DTO 与筛选类型，不会把
 * 服务端依赖带进客户端 bundle。状态机仍分别属于 approval_request 与
 * production_expense；这里仅统一展示口径。
 */

export const APPROVAL_CENTER_VIEWS = ["pending", "processed", "cc", "submitted"] as const;
export type ApprovalCenterView = (typeof APPROVAL_CENTER_VIEWS)[number];

export const APPROVAL_CENTER_BUSINESS_TYPES = [
  "resource_access",
  "member_exit",
  "owner_transfer",
  "expense",
] as const;
export type ApprovalCenterBusinessType = (typeof APPROVAL_CENTER_BUSINESS_TYPES)[number];

export const APPROVAL_CENTER_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type ApprovalCenterStatus = (typeof APPROVAL_CENTER_STATUSES)[number];

export const APPROVAL_CENTER_SORTS = ["newest", "oldest"] as const;
export type ApprovalCenterSort = (typeof APPROVAL_CENTER_SORTS)[number];

export type ApprovalCenterApprovalDetail = {
  kind: "approval_request";
  resourceType: string | null;
  resourceId: string | null;
  resourceSub: string | null;
  permissionLevel: string | null;
  grantType: "permanent" | "ttl" | null;
  requestedExpiresAt: string | null;
};

export type ApprovalCenterExpenseDetail = {
  kind: "expense";
  categoryId: string | null;
  categoryName: string | null;
  amount: string;
  currency: string;
};

export type ApprovalCenterItem = {
  /** 跨表稳定键，格式为 approval_request:<uuid> 或 expense:<uuid>。 */
  id: string;
  sourceId: string;
  source: "approval_request" | "expense";
  businessType: ApprovalCenterBusinessType;
  production: { id: string; name: string };
  applicant: { id: string; name: string };
  title: string;
  note: string | null;
  status: ApprovalCenterStatus;
  /** 原业务表状态，供详情跳转或诊断使用；不参与统一筛选。 */
  sourceStatus: string;
  canFinalizeForViewer: boolean;
  createdAt: string;
  resolvedAt: string | null;
  detail: ApprovalCenterApprovalDetail | ApprovalCenterExpenseDetail;
};

export type ApprovalCenterListParams = {
  view: ApprovalCenterView;
  businessTypes?: ApprovalCenterBusinessType[];
  statuses?: ApprovalCenterStatus[];
  from?: string;
  to?: string;
  query?: string;
  sort: ApprovalCenterSort;
  limit: number;
  cursor?: string;
};

export type ApprovalCenterPage = {
  items: ApprovalCenterItem[];
  nextCursor: string | null;
};

export class ApprovalCenterQueryError extends Error {}

function parseEnumList<T extends string>(
  values: string[],
  allowed: readonly T[],
  label: string,
): T[] | undefined {
  const parsed = [...new Set(values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))];
  if (parsed.length === 0) return undefined;
  const allowedSet = new Set<string>(allowed);
  if (parsed.some((value) => !allowedSet.has(value))) {
    throw new ApprovalCenterQueryError(`${label} 参数无效`);
  }
  return parsed as T[];
}

function parseTimestamp(value: string | null, label: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApprovalCenterQueryError(`${label} 参数无效`);
  return date.toISOString();
}

export function parseApprovalCenterListParams(searchParams: URLSearchParams): ApprovalCenterListParams {
  const viewRaw = searchParams.get("view") ?? "pending";
  if (!(APPROVAL_CENTER_VIEWS as readonly string[]).includes(viewRaw)) {
    throw new ApprovalCenterQueryError("view 参数无效");
  }

  const sortRaw = searchParams.get("sort") ?? "newest";
  if (!(APPROVAL_CENTER_SORTS as readonly string[]).includes(sortRaw)) {
    throw new ApprovalCenterQueryError("sort 参数无效");
  }

  const limitRaw = searchParams.get("limit") ?? "40";
  if (!/^\d+$/.test(limitRaw)) throw new ApprovalCenterQueryError("limit 参数无效");
  const limit = Number(limitRaw);
  if (limit < 1 || limit > 100) throw new ApprovalCenterQueryError("limit 必须在 1 到 100 之间");

  const from = parseTimestamp(searchParams.get("from"), "from");
  const to = parseTimestamp(searchParams.get("to"), "to");
  if (from && to && from >= to) throw new ApprovalCenterQueryError("from 必须早于 to");

  const query = searchParams.get("q")?.trim();
  if (query && query.length > 100) throw new ApprovalCenterQueryError("q 最多 100 个字符");

  const cursor = searchParams.get("cursor")?.trim();
  return {
    view: viewRaw as ApprovalCenterView,
    businessTypes: parseEnumList(
      searchParams.getAll("type"), APPROVAL_CENTER_BUSINESS_TYPES, "type",
    ),
    statuses: parseEnumList(searchParams.getAll("status"), APPROVAL_CENTER_STATUSES, "status"),
    from,
    to,
    query: query || undefined,
    sort: sortRaw as ApprovalCenterSort,
    limit,
    cursor: cursor || undefined,
  };
}
