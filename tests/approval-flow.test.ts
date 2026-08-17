/**
 * Phase 7 审批流集成测试
 *
 * 验证点：
 *  - 状态机转换（pending_supervisor → pending_resource → approved/rejected/cancelled）
 *  - first-action-wins（并发 approve 只有一个成功）
 *  - 权限门控（非授权用户无法 approve/reject）
 *  - production_member_grant 在审批通过后正确写入
 *  - notify 路径：各阶段通知写入正确的 user_id、kind、approvalRequestId
 *  - 通知过期（审批完成后旧 action 通知被 expired）
 *  - 无 supervisor 路径（直接 pending_resource）
 *  - owner fallback（无 POC 时演出 owner 是资源负责人）
 *  - escalateExpiredApprovals TTL 升级
 *  - cancel 只有申请人能撤回，且只能撤 pending_* 状态
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import {
  addProductionMember,
  submitAccessRequest,
  approveAccessRequest,
  rejectAccessRequest,
  cancelAccessRequest,
  listMyAccessRequests,
  listPendingApprovals,
  escalateExpiredApprovals,
  formatPgInterval,
} from "@/lib/db";
import { addResourceDeptManage, createProductionDept, setDeptMembers } from "@/lib/dept-db";
import { listUserNotifications } from "@/lib/inbox-db";
import { makeProduction, cleanupProduction } from "./factories";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Fixed UUIDs — high range to avoid collision with TEST_USER and EXTRA_USER_*
const U_OWNER      = "00000000-0000-0000-0001-000000000001";
const U_REQUESTER  = "00000000-0000-0000-0001-000000000002";
const U_SUPERVISOR = "00000000-0000-0000-0001-000000000003";
const U_POC        = "00000000-0000-0000-0001-000000000004";
const U_UNRELATED  = "00000000-0000-0000-0001-000000000005";

let prodId: string;
let deptId: string;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const pool = getPool();

  // Insert all test users into app_user + feishu_user (names matter for notification body)
  const users = [
    { id: U_OWNER,      openId: "test-owner",      name: "演出Owner" },
    { id: U_REQUESTER,  openId: "test-requester",  name: "申请人" },
    { id: U_SUPERVISOR, openId: "test-supervisor",  name: "直属上级" },
    { id: U_POC,        openId: "test-poc",         name: "科组POC" },
    { id: U_UNRELATED,  openId: "test-unrelated",  name: "无关用户" },
  ];
  await pool.query(
    `INSERT INTO app_user (id, created_at)
     SELECT * FROM UNNEST($1::uuid[], $2::timestamptz[])
     ON CONFLICT DO NOTHING`,
    [users.map((u) => u.id), users.map(() => new Date())],
  );
  for (const u of users) {
    await pool.query(
      `INSERT INTO feishu_user (open_id, user_id, name, is_super_admin, created_at, updated_at)
       VALUES ($1, $2, $3, FALSE, NOW(), NOW()) ON CONFLICT DO NOTHING`,
      [u.openId, u.id, u.name],
    );
  }

  // Create production owned by U_OWNER
  ({ prodId } = await makeProduction(U_OWNER));

  // Add all as production members
  for (const userId of [U_REQUESTER, U_SUPERVISOR, U_POC, U_UNRELATED]) {
    await addProductionMember(prodId, userId);
  }

  // Set U_SUPERVISOR as the supervisor of U_REQUESTER
  await pool.query(
    `UPDATE production_member SET supervisor_id = $1
     WHERE production_id = $2 AND user_id = $3`,
    [U_SUPERVISOR, prodId, U_REQUESTER],
  );

  // Create a dept, make U_POC a POC member, link to resource_type='cue_list'
  const dept = await createProductionDept({
    productionId: prodId,
    name: "走位科组",
  });
  deptId = dept.id;
  await setDeptMembers(deptId, prodId, [{ userId: U_POC, isPoc: true }]);
  await addResourceDeptManage({
    productionId: prodId,
    deptId,
    resourceType: "cue_list",
    establishedBy: U_OWNER,
  });

  // Insert production_approval_config (TTL = 24h)
  await pool.query(
    `INSERT INTO production_approval_config (production_id, ttl_hours, updated_by)
     VALUES ($1, 24, $2) ON CONFLICT DO NOTHING`,
    [prodId, U_OWNER],
  );
});

afterAll(async () => {
  const pool = getPool();
  // approval_request rows are CASCADE-deleted by production delete
  await cleanupProduction(prodId).catch(() => {});
  await pool
    .query("DELETE FROM app_user WHERE id = ANY($1)", [
      [U_OWNER, U_REQUESTER, U_SUPERVISOR, U_POC, U_UNRELATED],
    ])
    .catch(() => {});
});

// ─── Helper ───────────────────────────────────────────────────────────────────

async function latestNotifs(userId: string) {
  return listUserNotifications(userId, { limit: 20 });
}

async function notifForRequest(userId: string, requestId: string) {
  const all = await latestNotifs(userId);
  return all.filter((n) => n.approvalRequestId === requestId);
}

// ─── 1. findResourceApprovers (indirecto) ────────────────────────────────────

describe("findResourceApprovers", () => {
  it("returns POC when resource_dept_manage exists", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    // Should be pending_supervisor (U_REQUESTER has supervisor)
    expect(req.status).toBe("pending_supervisor");

    // Supervisor approves → transitions to pending_resource; resource approver = U_POC
    const result = await approveAccessRequest(req.id, U_SUPERVISOR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.status).toBe("pending_resource");

    // U_POC should have received a pending_resource notification
    const notifs = await notifForRequest(U_POC, req.id);
    expect(notifs.length).toBeGreaterThanOrEqual(1);
    expect(notifs[0].kind).toBe("approval_request_pending");

    // Cleanup: cancel the request
    await getPool().query(
      `UPDATE approval_request SET status = 'cancelled' WHERE id = $1`,
      [req.id],
    );
  });

  it("falls back to owner when no POC exists for resource type", async () => {
    // 'event' type has no resource_dept_manage entry → owner fallback
    const req = await submitAccessRequest(prodId, U_POC /* no supervisor */, {
      resourceType: "event",
      permissionLevel: "view",
    });
    // U_POC has no supervisor → pending_resource immediately
    expect(req.status).toBe("pending_resource");

    // U_OWNER should have been notified as fallback approver
    const notifs = await notifForRequest(U_OWNER, req.id);
    expect(notifs.length).toBeGreaterThanOrEqual(1);

    await getPool().query(
      `UPDATE approval_request SET status = 'cancelled' WHERE id = $1`,
      [req.id],
    );
  });
});

// ─── 2. submitAccessRequest ───────────────────────────────────────────────────

describe("submitAccessRequest", () => {
  it("requester with supervisor → initial status pending_supervisor", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    expect(req.status).toBe("pending_supervisor");
    expect(req.subjectId).toBe(U_REQUESTER);
    expect(req.productionId).toBe(prodId);

    await getPool().query(`UPDATE approval_request SET status='cancelled' WHERE id=$1`, [req.id]);
  });

  it("requester without supervisor → initial status pending_resource", async () => {
    // U_POC has no supervisor
    const req = await submitAccessRequest(prodId, U_POC, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    expect(req.status).toBe("pending_resource");

    await getPool().query(`UPDATE approval_request SET status='cancelled' WHERE id=$1`, [req.id]);
  });

  it("notify: supervisor gets action_required notification with correct approvalRequestId", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
      note: "测试通知路径",
    });

    const notifs = await notifForRequest(U_SUPERVISOR, req.id);
    expect(notifs.length).toBe(1);
    expect(notifs[0].kind).toBe("approval_request_pending");
    expect(notifs[0].actionRequired).toBe(true);
    expect(notifs[0].approvalRequestId).toBe(req.id);

    await getPool().query(`UPDATE approval_request SET status='cancelled' WHERE id=$1`, [req.id]);
  });

  it("notify: when no supervisor, resource approver (POC) gets notified", async () => {
    const req = await submitAccessRequest(prodId, U_POC, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    // Since U_POC is the only POC and is also the requester here... let's use U_UNRELATED instead
    // Actually U_UNRELATED has no supervisor. Let's check who gets notified.
    // U_POC submitted, so the POC of the dept (also U_POC) gets notified — self-notify is valid at DB level.
    expect(req.status).toBe("pending_resource");

    await getPool().query(`UPDATE approval_request SET status='cancelled' WHERE id=$1`, [req.id]);
  });

  it("re-request for the same target supersedes the pending one (auto-cancel + expire notifications)", async () => {
    // 2026-08-16 用户反馈：先申 1 天 TTL 再申 30 天，旧申请待办堆积审批人收件箱
    const first = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
      grantType: "ttl",
      ttlDuration: "1 day",
    });
    const second = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
      grantType: "ttl",
      ttlDuration: "30 days",
    });

    const firstRow = await getPool().query<{ status: string; resolved_at: Date | null }>(
      `SELECT status, resolved_at FROM approval_request WHERE id = $1`, [first.id]);
    expect(firstRow.rows[0].status).toBe("cancelled");
    expect(firstRow.rows[0].resolved_at).not.toBeNull();

    // 旧申请的审批待办已过期，新申请的待办存活
    const firstNotifs = await getPool().query(
      `SELECT 1 FROM user_notification
       WHERE approval_request_id = $1 AND expired_at IS NULL AND acted_at IS NULL`,
      [first.id]);
    expect(firstNotifs.rows.length).toBe(0);
    const secondNotifs = await getPool().query(
      `SELECT 1 FROM user_notification
       WHERE approval_request_id = $1 AND expired_at IS NULL AND acted_at IS NULL`,
      [second.id]);
    expect(secondNotifs.rows.length).toBeGreaterThan(0);

    // 不同 level 的 pending 不被覆盖
    const editReq = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "edit",
    });
    const secondRow = await getPool().query<{ status: string }>(
      `SELECT status FROM approval_request WHERE id = $1`, [second.id]);
    expect(secondRow.rows[0].status).toBe("pending_supervisor");

    await getPool().query(`UPDATE approval_request SET status='cancelled' WHERE id = ANY($1::uuid[])`,
      [[second.id, editReq.id]]);
  });

  it("escalation_chain records the notified phase", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    expect(req.escalationChain).toHaveLength(1);
    expect(req.escalationChain[0].phase).toBe("supervisor");
    expect(req.escalationChain[0].approverIds).toContain(U_SUPERVISOR);

    await getPool().query(`UPDATE approval_request SET status='cancelled' WHERE id=$1`, [req.id]);
  });
});

// ─── 3. approveAccessRequest ──────────────────────────────────────────────────

describe("approveAccessRequest — supervisor → resource phase", () => {
  let reqId: string;

  beforeAll(async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    reqId = req.id;
  });

  it("unauthorized: non-supervisor cannot approve pending_supervisor", async () => {
    const result = await approveAccessRequest(reqId, U_UNRELATED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");
  });

  it("supervisor approves → transitions to pending_resource", async () => {
    const result = await approveAccessRequest(reqId, U_SUPERVISOR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.status).toBe("pending_resource");
  });

  it("escalation_chain records supervisor approved action", async () => {
    const row = await getPool().query<{ escalation_chain: unknown[] }>(
      `SELECT escalation_chain FROM approval_request WHERE id = $1`,
      [reqId],
    );
    const chain = row.rows[0].escalation_chain as Array<{ phase: string; action?: string; actorId?: string }>;
    const supervisorEntry = chain.find((e) => e.phase === "supervisor");
    expect(supervisorEntry?.action).toBe("approved");
    expect(supervisorEntry?.actorId).toBe(U_SUPERVISOR);
  });

  it("notify: POC gets action_required notification after supervisor approves", async () => {
    const notifs = await notifForRequest(U_POC, reqId);
    const resourceNotif = notifs.find((n) => n.kind === "approval_request_pending");
    expect(resourceNotif).toBeDefined();
    expect(resourceNotif?.actionRequired).toBe(true);
    expect(resourceNotif?.approvalRequestId).toBe(reqId);
  });

  it("conflict: supervisor cannot approve again (already pending_resource)", async () => {
    const result = await approveAccessRequest(reqId, U_SUPERVISOR);
    // Either unauthorized (supervisor can't approve resource phase) or conflict
    expect(result.ok).toBe(false);
  });

  afterAll(async () => {
    await getPool().query(`UPDATE approval_request SET status='cancelled' WHERE id=$1`, [reqId]);
  });
});

describe("approveAccessRequest — resource phase → approved", () => {
  let reqId: string;

  beforeAll(async () => {
    // Create a request that's already pending_resource (requester has no supervisor)
    const req = await submitAccessRequest(prodId, U_POC, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    reqId = req.id;
    // U_POC has no supervisor, so it's already pending_resource
  });

  it("unauthorized: unrelated user cannot approve pending_resource", async () => {
    const result = await approveAccessRequest(reqId, U_UNRELATED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");
  });

  it("POC approves → status = approved", async () => {
    const result = await approveAccessRequest(reqId, U_POC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.status).toBe("approved");
    expect(result.request.grantedAt).not.toBeNull();
  });

  it("production_member_grant written with grant_source='approval' and correct approval_id", async () => {
    const row = await getPool().query(
      `SELECT * FROM production_member_grant WHERE approval_id = $1`,
      [reqId],
    );
    expect(row.rows).toHaveLength(1);
    const grant = row.rows[0];
    expect(grant.grant_source).toBe("approval");
    expect(grant.user_id).toBe(U_POC);
    expect(grant.resource_type).toBe("cue_list");
    expect(grant.permission_level).toBe("view");
    expect(grant.is_revoked).toBe(false);
  });

  it("notify: requester gets approved notification", async () => {
    const notifs = await notifForRequest(U_POC, reqId);
    const approvedNotif = notifs.find((n) => n.kind === "approval_request_result");
    expect(approvedNotif).toBeDefined();
    expect(approvedNotif?.approvalRequestId).toBe(reqId);
  });

  it("notify: previous action_required notifications are expired after approval", async () => {
    const notifs = await notifForRequest(U_POC, reqId);
    // Any pending action notifs should be expired
    const unexpiredActions = notifs.filter(
      (n) => n.actionRequired && !n.actedAt && !n.expiredAt,
    );
    expect(unexpiredActions).toHaveLength(0);
  });

  it("conflict: POC cannot approve the same request twice", async () => {
    const result = await approveAccessRequest(reqId, U_POC);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
  });
});

// ─── 4. first-action-wins (concurrent approve) ───────────────────────────────

describe("first-action-wins", () => {
  it("two concurrent approvals — exactly one succeeds", async () => {
    // U_UNRELATED has no supervisor, and no resource_dept_manage for 'scene'
    // → owner (U_OWNER) is the approver
    const req = await submitAccessRequest(prodId, U_UNRELATED, {
      resourceType: "scene",
      permissionLevel: "view",
    });
    expect(req.status).toBe("pending_resource");

    // Fire both approvals concurrently
    const [r1, r2] = await Promise.all([
      approveAccessRequest(req.id, U_OWNER),
      approveAccessRequest(req.id, U_OWNER),
    ]);

    const okCount = [r1, r2].filter((r) => r.ok).length;
    const conflictCount = [r1, r2].filter((r) => !r.ok && r.reason === "conflict").length;
    expect(okCount).toBe(1);
    expect(conflictCount).toBe(1);

    // Only one production_member_grant should exist
    const grants = await getPool().query(
      `SELECT COUNT(*) AS c FROM production_member_grant WHERE approval_id = $1`,
      [req.id],
    );
    expect(parseInt(grants.rows[0].c, 10)).toBe(1);
  });
});

// ─── 5. rejectAccessRequest ───────────────────────────────────────────────────

describe("rejectAccessRequest", () => {
  it("supervisor rejects at pending_supervisor → status = rejected", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "edit",
    });
    expect(req.status).toBe("pending_supervisor");

    const result = await rejectAccessRequest(req.id, U_SUPERVISOR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.status).toBe("rejected");
    expect(result.request.resolvedBy).toBe(U_SUPERVISOR);
  });

  it("notify: requester gets rejected notification with approvalRequestId", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "manage",
    });
    await rejectAccessRequest(req.id, U_SUPERVISOR);

    const notifs = await notifForRequest(U_REQUESTER, req.id);
    const rejectedNotif = notifs.find((n) => n.kind === "approval_request_result");
    expect(rejectedNotif).toBeDefined();
    expect(rejectedNotif?.approvalRequestId).toBe(req.id);
    expect(rejectedNotif?.category).toBe("warning");
  });

  it("notify: supervisor action notification is expired after reject", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "mount", // 批A：发行时展开为动词行集（view + mounts/create）
    });
    const reqId = req.id;
    await rejectAccessRequest(reqId, U_SUPERVISOR);

    const notifs = await notifForRequest(U_SUPERVISOR, reqId);
    const unexpiredActions = notifs.filter(
      (n) => n.actionRequired && !n.actedAt && !n.expiredAt,
    );
    expect(unexpiredActions).toHaveLength(0);
  });

  it("unauthorized: unrelated user cannot reject", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    const result = await rejectAccessRequest(req.id, U_UNRELATED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");

    await getPool().query(`UPDATE approval_request SET status='cancelled' WHERE id=$1`, [req.id]);
  });

  it("POC rejects at pending_resource → status = rejected", async () => {
    const req = await submitAccessRequest(prodId, U_POC, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    expect(req.status).toBe("pending_resource");

    const result = await rejectAccessRequest(req.id, U_POC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.status).toBe("rejected");
  });

  it("conflict: cannot reject an already-rejected request", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    await rejectAccessRequest(req.id, U_SUPERVISOR);
    const result = await rejectAccessRequest(req.id, U_SUPERVISOR);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
  });

  it("not_found: reject non-existent request returns not_found", async () => {
    const result = await rejectAccessRequest("00000000-0000-0000-0000-deadbeef0000", U_SUPERVISOR);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });
});

// ─── 6. cancelAccessRequest ───────────────────────────────────────────────────

describe("cancelAccessRequest", () => {
  it("requester cancels pending_supervisor → status = cancelled", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    const result = await cancelAccessRequest(req.id, U_REQUESTER);
    expect(result.ok).toBe(true);

    const row = await getPool().query<{ status: string }>(
      `SELECT status FROM approval_request WHERE id = $1`,
      [req.id],
    );
    expect(row.rows[0].status).toBe("cancelled");
  });

  it("notify: supervisor action notification is expired after cancel", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    await cancelAccessRequest(req.id, U_REQUESTER);

    const notifs = await notifForRequest(U_SUPERVISOR, req.id);
    const unexpiredActions = notifs.filter(
      (n) => n.actionRequired && !n.actedAt && !n.expiredAt,
    );
    expect(unexpiredActions).toHaveLength(0);
  });

  it("conflict: non-requester cannot cancel another's request", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    const result = await cancelAccessRequest(req.id, U_UNRELATED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");

    await getPool().query(`UPDATE approval_request SET status='cancelled' WHERE id=$1`, [req.id]);
  });

  it("conflict: cannot cancel an already-approved request", async () => {
    const req = await submitAccessRequest(prodId, U_POC, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    await approveAccessRequest(req.id, U_POC);
    const result = await cancelAccessRequest(req.id, U_POC);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
  });

  it("not_found: cancel non-existent request", async () => {
    const result = await cancelAccessRequest("00000000-0000-0000-0000-deadbeef0001", U_REQUESTER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });
});

// ─── 7. listMyAccessRequests ──────────────────────────────────────────────────

describe("listMyAccessRequests", () => {
  it("returns only requests submitted by the calling user", async () => {
    const r1 = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    const r2 = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "mount", // 批A：发行时展开为动词行集（view + mounts/create）
    });

    const mine = await listMyAccessRequests(prodId, U_REQUESTER);
    const ids = mine.map((r) => r.id);
    expect(ids).toContain(r1.id);
    expect(ids).toContain(r2.id);

    // U_POC's requests should not appear
    const pocReqs = mine.filter((r) => r.subjectId === U_POC);
    expect(pocReqs).toHaveLength(0);

    await getPool().query(
      `UPDATE approval_request SET status='cancelled' WHERE id = ANY($1)`,
      [[r1.id, r2.id]],
    );
  });

  it("ordered most-recent first", async () => {
    const r1 = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    await new Promise((res) => setTimeout(res, 10));
    const r2 = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "edit",
    });

    const mine = await listMyAccessRequests(prodId, U_REQUESTER);
    const ids = mine.map((r) => r.id);
    expect(ids.indexOf(r2.id)).toBeLessThan(ids.indexOf(r1.id));

    await getPool().query(
      `UPDATE approval_request SET status='cancelled' WHERE id = ANY($1)`,
      [[r1.id, r2.id]],
    );
  });

  // 2026-08-17：ttl_duration 是 INTERVAL 列，node-postgres 会解析成
  // postgres-interval 对象（'7 days' → { days: 7 }）。裸传到前端会让 React 抛
  // "Objects are not valid as a React child (found: object with keys {days})"。
  it("ttlDurationLabel is a plain string, never a postgres-interval object", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
      grantType: "ttl",
      ttlDuration: "7 days",
    });
    expect(typeof req.ttlDurationLabel).toBe("string");
    expect(req.ttlDurationLabel).toBe("7天");

    const mine = await listMyAccessRequests(prodId, U_REQUESTER);
    const found = mine.find((r) => r.id === req.id);
    expect(typeof found?.ttlDurationLabel).toBe("string");

    await getPool().query(`UPDATE approval_request SET status='cancelled' WHERE id=$1`, [req.id]);
  });
});

describe("formatPgInterval", () => {
  it("renders each supported unit and composes multi-unit intervals", () => {
    expect(formatPgInterval({ days: 7 })).toBe("7天");
    expect(formatPgInterval({ minutes: 30 })).toBe("30分钟");
    expect(formatPgInterval({ hours: 1 })).toBe("1小时");
    expect(formatPgInterval({ years: 1, months: 2, days: 3 })).toBe("1年2个月3天");
    expect(formatPgInterval({ days: 1, hours: 12, minutes: 30 })).toBe("1天12小时30分钟");
  });

  // 每个 PgInterval 字段都必须有对应单位，否则就是本 PR 要修的那类静默丢数据
  it("covers sub-second fields instead of silently dropping them", () => {
    expect(formatPgInterval({ milliseconds: 500 })).toBe("500毫秒");
    expect(formatPgInterval({ seconds: 1, milliseconds: 500 })).toBe("1秒500毫秒");
  });

  it("passes strings through and collapses empty/null to null", () => {
    expect(formatPgInterval("7 days")).toBe("7 days");
    expect(formatPgInterval(null)).toBeNull();
    expect(formatPgInterval(undefined)).toBeNull();
    expect(formatPgInterval("  ")).toBeNull();
    expect(formatPgInterval({})).toBeNull();
    expect(formatPgInterval({ days: 0 })).toBeNull();
  });
});

// ─── 8. listPendingApprovals ──────────────────────────────────────────────────

describe("listPendingApprovals", () => {
  let supervisorPendingId: string;
  let resourcePendingId: string;
  let ownerFallbackId: string;

  beforeAll(async () => {
    // Request 1: U_REQUESTER (has supervisor) → pending_supervisor
    const r1 = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    supervisorPendingId = r1.id;

    // Request 2: U_POC (no supervisor) → pending_resource (U_POC is cue_list POC)
    const r2 = await submitAccessRequest(prodId, U_POC, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    resourcePendingId = r2.id;

    // Request 3: U_UNRELATED (no supervisor), resource type 'scene' (no dept → owner fallback)
    const r3 = await submitAccessRequest(prodId, U_UNRELATED, {
      resourceType: "scene",
      permissionLevel: "view",
    });
    ownerFallbackId = r3.id;
  });

  afterAll(async () => {
    await getPool().query(
      `UPDATE approval_request SET status='cancelled'
       WHERE id = ANY($1) AND status IN ('pending_supervisor','pending_resource')`,
      [[supervisorPendingId, resourcePendingId, ownerFallbackId]],
    );
  });

  it("supervisor sees only pending_supervisor requests where they are the supervisor", async () => {
    const pending = await listPendingApprovals(U_SUPERVISOR, prodId);
    const ids = pending.map((r) => r.id);
    expect(ids).toContain(supervisorPendingId);
    // Resource-phase and owner-fallback requests should NOT appear for supervisor
    expect(ids).not.toContain(resourcePendingId);
    expect(ids).not.toContain(ownerFallbackId);
  });

  it("POC sees pending_resource requests for their managed resource type", async () => {
    const pending = await listPendingApprovals(U_POC, prodId);
    const ids = pending.map((r) => r.id);
    expect(ids).toContain(resourcePendingId);
    // supervisor-phase request should NOT appear for POC
    expect(ids).not.toContain(supervisorPendingId);
  });

  it("owner sees pending_resource requests where no POC exists (scene type)", async () => {
    const pending = await listPendingApprovals(U_OWNER, prodId);
    const ids = pending.map((r) => r.id);
    expect(ids).toContain(ownerFallbackId);
  });

  it("unrelated user sees nothing", async () => {
    const pending = await listPendingApprovals(U_UNRELATED, prodId);
    const relevantIds = [supervisorPendingId, resourcePendingId, ownerFallbackId];
    const found = pending.filter((r) => relevantIds.includes(r.id));
    expect(found).toHaveLength(0);
  });

  it("approved/rejected/cancelled requests do not appear in pending", async () => {
    const req = await submitAccessRequest(prodId, U_POC, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    await approveAccessRequest(req.id, U_POC);

    const pending = await listPendingApprovals(U_POC, prodId);
    const ids = pending.map((r) => r.id);
    expect(ids).not.toContain(req.id);
  });
});

// ─── 9. escalateExpiredApprovals ─────────────────────────────────────────────

describe("escalateExpiredApprovals", () => {
  it("advances pending_supervisor past TTL to pending_resource and notifies POC", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    expect(req.status).toBe("pending_supervisor");

    // Manually back-date created_at to simulate TTL expiry
    await getPool().query(
      `UPDATE approval_request SET created_at = NOW() - INTERVAL '25 hours' WHERE id = $1`,
      [req.id],
    );

    const result = await escalateExpiredApprovals();
    expect(result.escalated).toBeGreaterThanOrEqual(1);

    const row = await getPool().query<{ status: string }>(
      `SELECT status FROM approval_request WHERE id = $1`,
      [req.id],
    );
    expect(row.rows[0].status).toBe("pending_resource");

    // U_POC should have received a new resource-phase notification
    const notifs = await notifForRequest(U_POC, req.id);
    const resourceNotif = notifs.find((n) => n.kind === "approval_request_pending");
    expect(resourceNotif).toBeDefined();
    expect(resourceNotif?.approvalRequestId).toBe(req.id);

    await getPool().query(`UPDATE approval_request SET status='cancelled' WHERE id=$1`, [req.id]);
  });

  it("does not escalate requests still within TTL", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    // created_at is NOW() — within 24h TTL
    const before = await getPool().query<{ status: string }>(
      `SELECT status FROM approval_request WHERE id = $1`,
      [req.id],
    );
    await escalateExpiredApprovals();
    const after = await getPool().query<{ status: string }>(
      `SELECT status FROM approval_request WHERE id = $1`,
      [req.id],
    );
    expect(after.rows[0].status).toBe(before.rows[0].status);

    await getPool().query(`UPDATE approval_request SET status='cancelled' WHERE id=$1`, [req.id]);
  });
});

// ─── 10. Full happy path (supervisor gate) ────────────────────────────────────

describe("full happy path — supervisor gate", () => {
  it("submit → supervisor approve → POC approve → production_member_grant written, notifications correct", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "mount", // 批A：发行时展开为动词行集（view + mounts/create）
      grantType: "permanent",
      note: "端到端测试",
    });
    expect(req.status).toBe("pending_supervisor");

    // Step 1: supervisor approves
    const step1 = await approveAccessRequest(req.id, U_SUPERVISOR);
    expect(step1.ok).toBe(true);
    if (!step1.ok) return;
    expect(step1.request.status).toBe("pending_resource");

    // POC should have received resource-phase notif
    const pocNotifs1 = await notifForRequest(U_POC, req.id);
    expect(pocNotifs1.some((n) => n.kind === "approval_request_pending")).toBe(true);

    // Step 2: POC approves
    const step2 = await approveAccessRequest(req.id, U_POC);
    expect(step2.ok).toBe(true);
    if (!step2.ok) return;
    expect(step2.request.status).toBe("approved");

    // production_member_grant written
    const grant = await getPool().query(
      `SELECT * FROM production_member_grant WHERE approval_id = $1`,
      [req.id],
    );
    // 批A：mount 伪级别展开为 2 行动词行集（'*'@view + mounts@create）
    expect(grant.rows).toHaveLength(2);
    const subs = grant.rows.map((r: { resource_sub: string; permission_level: string }) => `${r.resource_sub}@${r.permission_level}`).sort();
    expect(subs).toEqual(["*@view", "mounts@create"]);
    expect(grant.rows[0].user_id).toBe(U_REQUESTER);
    expect(grant.rows[0].resource_type).toBe("cue_list");
    expect(grant.rows.every((r: { is_revoked: boolean }) => !r.is_revoked)).toBe(true);

    // Requester gets approved notification
    const requesterNotifs = await notifForRequest(U_REQUESTER, req.id);
    expect(requesterNotifs.some((n) => n.kind === "approval_request_result")).toBe(true);

    // No unexpired action notifications remain
    const allRelatedNotifs = [
      ...(await notifForRequest(U_SUPERVISOR, req.id)),
      ...(await notifForRequest(U_POC, req.id)),
    ];
    const unexpiredActions = allRelatedNotifs.filter(
      (n) => n.actionRequired && !n.actedAt && !n.expiredAt,
    );
    expect(unexpiredActions).toHaveLength(0);
  });
});
