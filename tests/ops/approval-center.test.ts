/**
 * 审批中心统一读模型：跨 approval_request / production_expense 的参与者隔离、
 * 四种视图、筛选排序分页与 API 参数门。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { listApprovalCenterItems } from "@/lib/approval/approval-center-db";
import type { ApprovalCenterListParams } from "@/lib/approval/approval-center-types";
import { GET as approvalCenterHandler } from "@/app/api/my/approval-center/route";
import { getPool } from "@/lib/pg";
import { cleanupProduction, makeProduction, shortId } from "../_support/factories";

let viewerId: string;
let applicantA: string;
let applicantB: string;
let outsiderId: string;
let prodA: string;
let prodB: string;

const ids: Record<string, string> = {};

function options(overrides: Partial<ApprovalCenterListParams> = {}): ApprovalCenterListParams {
  return { view: "pending", sort: "newest", limit: 40, ...overrides };
}

async function insertApproval(params: {
  productionId: string;
  subjectId: string;
  type: "resource_access" | "member_exit" | "owner_transfer";
  status: "pending_supervisor" | "pending_resource" | "approved" | "rejected" | "cancelled";
  createdAt: string;
  currentApproverIds?: string[];
  escalationChain?: unknown[];
  flowSnapshot?: unknown;
  note?: string;
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO approval_request
       (production_id, subject_id, type, resource_type, resource_id, resource_sub,
        permission_level, note, status, current_approver_ids, escalation_chain,
        flow_snapshot, created_at, resolved_at)
     VALUES ($1, $2, $3,
             CASE WHEN $3 = 'resource_access' THEN 'wiki' ELSE NULL END,
             CASE WHEN $3 = 'resource_access' THEN '*' ELSE NULL END,
             CASE WHEN $3 = 'resource_access' THEN '*' ELSE NULL END,
             CASE WHEN $3 = 'resource_access' THEN 'view' ELSE NULL END,
             $4, $5, $6::uuid[], $7::jsonb, $8::jsonb, $9::timestamptz,
             CASE WHEN $5 IN ('approved', 'rejected', 'cancelled')
                  THEN $9::timestamptz + interval '1 hour' ELSE NULL END)
     RETURNING id`,
    [
      params.productionId,
      params.subjectId,
      params.type,
      params.note ?? null,
      params.status,
      params.currentApproverIds ?? [],
      JSON.stringify(params.escalationChain ?? []),
      params.flowSnapshot ? JSON.stringify(params.flowSnapshot) : null,
      params.createdAt,
    ],
  );
  return rows[0].id;
}

async function insertExpense(params: {
  productionId: string;
  submittedBy: string;
  title: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  createdAt: string;
  currentApproverIds?: string[];
  escalationChain?: unknown[];
  resolvedBy?: string;
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO production_expense
       (production_id, title, amount, currency, note, submitted_by, status,
        current_approver_ids, escalation_chain, created_at, updated_at, resolved_at, resolved_by)
     VALUES ($1, $2, 123.45, 'CNY', '舞台餐费', $3, $4, $5::uuid[], $6::jsonb,
             $7::timestamptz, $7::timestamptz,
             CASE WHEN $4 IN ('approved', 'rejected', 'cancelled')
                  THEN $7::timestamptz + interval '1 hour' ELSE NULL END,
             $8)
     RETURNING id`,
    [
      params.productionId,
      params.title,
      params.submittedBy,
      params.status,
      params.currentApproverIds ?? [],
      JSON.stringify(params.escalationChain ?? []),
      params.createdAt,
      params.resolvedBy ?? null,
    ],
  );
  return rows[0].id;
}

beforeAll(async () => {
  viewerId = (await upsertFeishuUser(`test-open-${shortId()}`, "审批中心查看者", null, false)).userId;
  applicantA = (await upsertFeishuUser(`test-open-${shortId()}`, "申请人甲", null, false)).userId;
  applicantB = (await upsertFeishuUser(`test-open-${shortId()}`, "申请人乙", null, false)).userId;
  outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, "无关用户", null, false)).userId;
  ({ prodId: prodA } = await makeProduction(applicantA));
  ({ prodId: prodB } = await makeProduction(applicantB));
  await getPool().query("UPDATE production SET name = '雾港项目甲' WHERE id = $1", [prodA]);
  await getPool().query("UPDATE production SET name = '灯塔项目乙' WHERE id = $1", [prodB]);

  ids.pendingAccess = await insertApproval({
    productionId: prodA,
    subjectId: applicantA,
    type: "resource_access",
    status: "pending_resource",
    createdAt: "2026-01-10T08:00:00.000Z",
    currentApproverIds: [viewerId],
    escalationChain: [{ approverIds: [viewerId], canFinalize: true }],
    note: "申请查看排练文档",
  });
  ids.processedExit = await insertApproval({
    productionId: prodA,
    subjectId: applicantA,
    type: "member_exit",
    status: "approved",
    createdAt: "2026-02-10T08:00:00.000Z",
    escalationChain: [{
      approverIds: [viewerId], canFinalize: true, action: "approved",
      actorId: viewerId, actedAt: "2026-02-10T09:00:00.000Z",
    }],
  });
  ids.ccAccess = await insertApproval({
    productionId: prodB,
    subjectId: applicantB,
    type: "resource_access",
    status: "pending_resource",
    createdAt: "2026-03-10T08:00:00.000Z",
    currentApproverIds: [applicantA],
    flowSnapshot: {
      v: 1,
      templateId: "test-template",
      templateName: "测试流程",
      cursor: 1,
      rev: 0,
      nodes: [{ id: "cc", type: "cc", title: "知会", state: "done", deliveredTo: [viewerId] }],
    },
  });
  ids.submittedTransfer = await insertApproval({
    productionId: prodA,
    subjectId: viewerId,
    type: "owner_transfer",
    status: "cancelled",
    createdAt: "2026-04-10T08:00:00.000Z",
  });
  ids.pendingExpense = await insertExpense({
    productionId: prodB,
    submittedBy: applicantB,
    title: "灯塔布景材料",
    status: "pending",
    createdAt: "2026-05-10T08:00:00.000Z",
    currentApproverIds: [viewerId],
    escalationChain: [{ approverIds: [viewerId], canFinalize: false }],
  });
  ids.submittedExpense = await insertExpense({
    productionId: prodB,
    submittedBy: viewerId,
    title: "首演舞台餐报销",
    status: "rejected",
    createdAt: "2026-06-10T08:00:00.000Z",
  });
  ids.processedExpense = await insertExpense({
    productionId: prodB,
    submittedBy: applicantB,
    title: "已驳回交通费",
    status: "rejected",
    createdAt: "2026-02-20T08:00:00.000Z",
    resolvedBy: viewerId,
  });
  ids.unrelated = await insertApproval({
    productionId: prodA,
    subjectId: applicantA,
    type: "resource_access",
    status: "pending_resource",
    createdAt: "2026-07-10T08:00:00.000Z",
    currentApproverIds: [outsiderId],
  });
});

afterAll(async () => {
  await cleanupProduction(prodA).catch(() => {});
  await cleanupProduction(prodB).catch(() => {});
});

describe("审批中心读模型", () => {
  it("四种视图分别读取业务事实，不使用通知记录", async () => {
    const pending = await listApprovalCenterItems(viewerId, options({ view: "pending" }));
    expect(pending.items.map((item) => item.sourceId).sort()).toEqual(
      [ids.pendingAccess, ids.pendingExpense].sort(),
    );
    expect(pending.items.find((item) => item.sourceId === ids.pendingExpense)?.canFinalizeForViewer).toBe(false);

    const processed = await listApprovalCenterItems(viewerId, options({ view: "processed" }));
    expect(processed.items.map((item) => item.sourceId)).toEqual([
      ids.processedExpense,
      ids.processedExit,
    ]);

    const cc = await listApprovalCenterItems(viewerId, options({ view: "cc" }));
    expect(cc.items.map((item) => item.sourceId)).toEqual([ids.ccAccess]);

    const submitted = await listApprovalCenterItems(viewerId, options({ view: "submitted" }));
    expect(submitted.items.map((item) => item.sourceId)).toEqual([
      ids.submittedExpense,
      ids.submittedTransfer,
    ]);
  });

  it("跨项目只返回当前用户实际参与的项目与实例", async () => {
    const pending = await listApprovalCenterItems(viewerId, options({ view: "pending" }));
    expect(new Set(pending.items.map((item) => item.production.id))).toEqual(new Set([prodA, prodB]));
    expect(pending.items.map((item) => item.sourceId)).not.toContain(ids.unrelated);

    const outsider = await listApprovalCenterItems(outsiderId, options({ view: "pending" }));
    expect(outsider.items.map((item) => item.sourceId)).toEqual([ids.unrelated]);
    expect(outsider.items.map((item) => item.sourceId)).not.toContain(ids.pendingAccess);
  });

  it("支持业务类型、状态、时间和搜索筛选", async () => {
    const expenseOnly = await listApprovalCenterItems(viewerId, options({
      view: "submitted",
      businessTypes: ["expense"],
      statuses: ["rejected"],
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-07-01T00:00:00.000Z",
      query: "舞台餐",
    }));
    expect(expenseOnly.items.map((item) => item.sourceId)).toEqual([ids.submittedExpense]);
    expect(expenseOnly.items[0].detail).toMatchObject({
      kind: "expense", amount: "123.45", currency: "CNY",
    });

    const transferOnly = await listApprovalCenterItems(viewerId, options({
      view: "submitted", businessTypes: ["owner_transfer"], statuses: ["cancelled"],
    }));
    expect(transferOnly.items.map((item) => item.sourceId)).toEqual([ids.submittedTransfer]);
  });

  it("按稳定顺序游标分页，且游标不能跨排序方向复用", async () => {
    const first = await listApprovalCenterItems(viewerId, options({
      view: "submitted", sort: "oldest", limit: 1,
    }));
    expect(first.items[0].sourceId).toBe(ids.submittedTransfer);
    expect(first.nextCursor).toBeTruthy();

    const second = await listApprovalCenterItems(viewerId, options({
      view: "submitted", sort: "oldest", limit: 1, cursor: first.nextCursor!,
    }));
    expect(second.items.map((item) => item.sourceId)).toEqual([ids.submittedExpense]);
    expect(second.nextCursor).toBeNull();

    await expect(listApprovalCenterItems(viewerId, options({
      view: "submitted", sort: "newest", cursor: first.nextCursor!,
    }))).rejects.toThrow("cursor 与 sort 不匹配");
  });
});

describe("GET /api/my/approval-center", () => {
  function request(path: string, userId?: string): NextRequest {
    const req = new NextRequest(`http://localhost${path}`);
    if (userId) {
      req.cookies.set(SESSION_COOKIE, createSession({
        userId, name: "测试", avatarUrl: null, isAdmin: false,
      }));
    }
    return req;
  }

  it("未登录返回 401，非法筛选返回 400", async () => {
    expect((await approvalCenterHandler(request("/api/my/approval-center"))).status).toBe(401);
    expect((await approvalCenterHandler(request(
      "/api/my/approval-center?view=unknown", viewerId,
    ))).status).toBe(400);
    expect((await approvalCenterHandler(request(
      "/api/my/approval-center?from=2026-07-01&to=2026-06-01", viewerId,
    ))).status).toBe(400);
  });

  it("返回统一 DTO，并接受重复筛选参数", async () => {
    const response = await approvalCenterHandler(request(
      "/api/my/approval-center?view=pending&type=resource_access&type=expense&sort=oldest",
      viewerId,
    ));
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ sourceId: string }>; nextCursor: string | null };
    expect(body.items.map((item) => item.sourceId)).toEqual([ids.pendingAccess, ids.pendingExpense]);
    expect(body.nextCursor).toBeNull();
  });
});
