/**
 * 审批流集成测试（#140 阶梯升级 + #256 TTL 修复后）
 *
 * 验证点：
 *  - 阶梯路由（lib/approval-routing）：supervisor 链 → 持有者 → 共管部门 POC
 *    → 父部门 POC → 制作人 → owner，申请人本人恒被排除，跨级去重
 *  - 敏感度分流：SENSITIVE 直达 owner（制作人代批不了）、ROOT 拒收申请
 *  - supervisor 语义：本人持有该权限 → 批准即终局；不持有 → 只能向上转交
 *  - 转交（escalate）与 TTL 超时升级都沿阶梯单调前进，链路记在 escalation_chain
 *  - first-action-wins（并发 approve 只有一个成功）
 *  - 权限门控（非授权用户无法 approve/reject/escalate）
 *  - #256：grantType='ttl' 必须带白名单内的时长，批准后 expires_at 非 NULL
 *  - 通知路径：各级审批人拿到的动作（批准 / 转交）与其 canFinalize 一致
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "fs/promises";
import path from "path";
import { getPool } from "@/lib/pg";
import {
  addProductionMember,
  submitAccessRequest,
  approveAccessRequest,
  escalateAccessRequest,
  rejectAccessRequest,
  cancelAccessRequest,
  listMyAccessRequests,
  listPendingApprovals,
  escalateExpiredApprovals,
  formatPgInterval,
  ApprovalRequestError,
} from "@/lib/db";
import { buildApprovalLadder, classifyApprovalNode, nextStage } from "@/lib/approval-routing";
import { TTL_OPTIONS, isValidTtlInterval, displayTtlLabel } from "@/lib/approval-ttl";
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
const U_HOLDER     = "00000000-0000-0000-0001-000000000006";
const U_ANC_POC    = "00000000-0000-0000-0001-000000000007";
const U_PRODUCER   = "00000000-0000-0000-0001-000000000008";

const ALL_USERS = [
  { id: U_OWNER,      openId: "test-owner",      name: "演出Owner" },
  { id: U_REQUESTER,  openId: "test-requester",  name: "申请人" },
  { id: U_SUPERVISOR, openId: "test-supervisor", name: "直属上级" },
  { id: U_POC,        openId: "test-poc",        name: "科组POC" },
  { id: U_UNRELATED,  openId: "test-unrelated",  name: "无关用户" },
  { id: U_HOLDER,     openId: "test-holder",     name: "资源持有者" },
  { id: U_ANC_POC,    openId: "test-anc-poc",    name: "上级科组POC" },
  { id: U_PRODUCER,   openId: "test-producer",   name: "制作人甲" },
];

let prodId: string;
let deptId: string;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const pool = getPool();

  await pool.query(
    `INSERT INTO app_user (id, created_at)
     SELECT * FROM UNNEST($1::uuid[], $2::timestamptz[])
     ON CONFLICT DO NOTHING`,
    [ALL_USERS.map((u) => u.id), ALL_USERS.map(() => new Date())],
  );
  for (const u of ALL_USERS) {
    await pool.query(
      `INSERT INTO feishu_user (open_id, user_id, name, is_super_admin, created_at, updated_at)
       VALUES ($1, $2, $3, FALSE, NOW(), NOW()) ON CONFLICT DO NOTHING`,
      [u.openId, u.id, u.name],
    );
  }

  // Create production owned by U_OWNER
  ({ prodId } = await makeProduction(U_OWNER));

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
  const dept = await createProductionDept({ productionId: prodId, name: "走位科组" });
  deptId = dept.id;
  await setDeptMembers(deptId, prodId, [{ userId: U_POC, isPoc: true }]);
  await addResourceDeptManage({
    productionId: prodId,
    deptId,
    resourceType: "cue_list",
    establishedBy: U_OWNER,
  });

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
    .query("DELETE FROM app_user WHERE id = ANY($1)", [ALL_USERS.map((u) => u.id)])
    .catch(() => {});
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function latestNotifs(userId: string) {
  return listUserNotifications(userId, { limit: 30 });
}

async function notifForRequest(userId: string, requestId: string) {
  const all = await latestNotifs(userId);
  return all.filter((n) => n.approvalRequestId === requestId);
}

async function cancelRows(ids: string[]) {
  await getPool().query(
    `UPDATE approval_request SET status='cancelled', current_stage=NULL, current_approver_ids='{}'
     WHERE id = ANY($1::uuid[]) AND status IN ('pending_supervisor','pending_resource')`,
    [ids],
  );
}

/** 给某人发一条真授权行（用于制造「上级已持有该权限」的局面）。 */
async function grantRows(
  userId: string,
  rows: ReadonlyArray<readonly [string, string]>,
  resourceType = "cue_list",
) {
  for (const [sub, verb] of rows) {
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES ($1,$2,$3,'*',$4,$5,'direct')
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [prodId, userId, resourceType, sub, verb],
    );
  }
}

async function revokeAll(userId: string) {
  await getPool().query(
    `DELETE FROM production_member_grant WHERE production_id = $1 AND user_id = $2`,
    [prodId, userId],
  );
}

function target(over: Partial<Parameters<typeof buildApprovalLadder>[0]> = {}) {
  return {
    productionId: prodId,
    subjectId: U_REQUESTER,
    resourceType: "cue_list",
    resourceId: "*",
    resourceSub: "*",
    permissionLevel: "view",
    ...over,
  };
}

// ─── 1. 阶梯路由 ──────────────────────────────────────────────────────────────

describe("buildApprovalLadder — 阶梯顺序与成员", () => {
  it("默认阶梯：直属上级 → 共管部门 POC → owner 兜底", async () => {
    const ladder = await buildApprovalLadder(target());
    expect(ladder.map((s) => s.stage)).toEqual(["supervisor", "dept_poc", "owner"]);
    expect(ladder[0].approverIds).toEqual([U_SUPERVISOR]);
    expect(ladder[1].approverIds).toEqual([U_POC]);
    expect(ladder[2].approverIds).toEqual([U_OWNER]);
  });

  it("上级本人未持有该权限 → canFinalize=false（只能转交）", async () => {
    const ladder = await buildApprovalLadder(target());
    expect(ladder[0].canFinalize).toBe(false);
    // 资源侧各级恒可终局
    expect(ladder.slice(1).every((s) => s.canFinalize)).toBe(true);
  });

  it("上级持有申请的全部动词行 → canFinalize=true", async () => {
    await grantRows(U_SUPERVISOR, [["*", "view"]]);
    try {
      const ladder = await buildApprovalLadder(target());
      expect(ladder[0].canFinalize).toBe(true);
      // 伪级别 mount 展开成两行，上级只有 view → 仍算无权
      const mountLadder = await buildApprovalLadder(target({ permissionLevel: "mount" }));
      expect(mountLadder[0].canFinalize).toBe(false);
    } finally {
      await revokeAll(U_SUPERVISOR);
    }
  });

  it("申请人本人不出现在任何一级（POC 申请自己管的资源）", async () => {
    const ladder = await buildApprovalLadder(target({ subjectId: U_POC }));
    expect(ladder.flatMap((s) => s.approverIds)).not.toContain(U_POC);
    expect(ladder.map((s) => s.stage)).toEqual(["owner"]);
  });

  it("资源持有者（grants@edit 行）排在部门 POC 之前", async () => {
    await grantRows(U_HOLDER, [["grants", "edit"]]);
    try {
      const ladder = await buildApprovalLadder(target());
      expect(ladder.map((s) => s.stage)).toEqual(["supervisor", "holder", "dept_poc", "owner"]);
      expect(ladder[1].approverIds).toEqual([U_HOLDER]);
    } finally {
      await revokeAll(U_HOLDER);
    }
  });

  it("上级链成环时不会无限展开（申请人 → A → 申请人）", async () => {
    // U_REQUESTER 的上级是 U_SUPERVISOR，再把 U_SUPERVISOR 的上级设回申请人
    await getPool().query(
      `UPDATE production_member SET supervisor_id = $1 WHERE production_id = $2 AND user_id = $3`,
      [U_REQUESTER, prodId, U_SUPERVISOR],
    );
    try {
      const ladder = await buildApprovalLadder(target());
      const supervisorStages = ladder.filter((s) => s.stage === "supervisor");
      expect(supervisorStages).toHaveLength(1);
      expect(supervisorStages[0].approverIds).toEqual([U_SUPERVISOR]);
      // 环没有把申请人本人拉进审批人集合
      expect(ladder.flatMap((s) => s.approverIds)).not.toContain(U_REQUESTER);
    } finally {
      await getPool().query(
        `UPDATE production_member SET supervisor_id = NULL WHERE production_id = $1 AND user_id = $2`,
        [prodId, U_SUPERVISOR],
      );
    }
  });

  it("多级上级链逐跳展开，每跳一级", async () => {
    // U_REQUESTER → U_SUPERVISOR → U_HOLDER
    await addProductionMember(prodId, U_HOLDER);
    await getPool().query(
      `UPDATE production_member SET supervisor_id = $1 WHERE production_id = $2 AND user_id = $3`,
      [U_HOLDER, prodId, U_SUPERVISOR],
    );
    try {
      const ladder = await buildApprovalLadder(target());
      const sup = ladder.filter((s) => s.stage === "supervisor");
      expect(sup.map((s) => [s.depth, s.approverIds])).toEqual([
        [0, [U_SUPERVISOR]], [1, [U_HOLDER]],
      ]);
    } finally {
      await getPool().query(
        `UPDATE production_member SET supervisor_id = NULL WHERE production_id = $1 AND user_id = $2`,
        [prodId, U_SUPERVISOR],
      );
    }
  });

  it("SENSITIVE 节点跳过整条链，直达 owner", async () => {
    expect(classifyApprovalNode("production", "meta", "edit")).toBe("sensitive");
    const ladder = await buildApprovalLadder(
      target({ resourceType: "production", resourceSub: "meta", permissionLevel: "edit" }),
    );
    expect(ladder.map((s) => s.stage)).toEqual(["owner"]);
    expect(ladder[0].approverIds).toEqual([U_OWNER]);
  });

  it("ROOT 节点无审批通道 → 阶梯为空", async () => {
    expect(classifyApprovalNode("production", "owner", "edit")).toBe("root");
    const ladder = await buildApprovalLadder(
      target({ resourceType: "production", resourceSub: "owner", permissionLevel: "edit" }),
    );
    expect(ladder).toEqual([]);
  });

  it("nextStage 按阶梯序单调前进，链顶返回 null", async () => {
    const ladder = await buildApprovalLadder(target());
    expect(nextStage(ladder, null)?.stage).toBe("supervisor");
    expect(nextStage(ladder, { stage: "supervisor", depth: 0 })?.stage).toBe("dept_poc");
    expect(nextStage(ladder, { stage: "dept_poc", depth: 0 })?.stage).toBe("owner");
    expect(nextStage(ladder, { stage: "owner", depth: 0 })).toBeNull();
    // 阶梯形状变了也不回退：holder 级晚于 supervisor，早于 dept_poc
    expect(nextStage(ladder, { stage: "holder", depth: 0 })?.stage).toBe("dept_poc");
  });
});

describe("buildApprovalLadder — 完整五级（独立演出）", () => {
  let p2: string;
  let childDept: string;

  beforeAll(async () => {
    ({ prodId: p2 } = await makeProduction(U_OWNER));
    for (const u of [U_REQUESTER, U_SUPERVISOR, U_POC, U_ANC_POC, U_PRODUCER, U_HOLDER]) {
      await addProductionMember(p2, u);
    }
    await getPool().query(
      `UPDATE production_member SET supervisor_id = $1 WHERE production_id = $2 AND user_id = $3`,
      [U_SUPERVISOR, p2, U_REQUESTER],
    );
    // 制作人：结构性角色，按名匹配
    await getPool().query(
      `UPDATE production_member SET roles = ARRAY['制作人'] WHERE production_id = $1 AND user_id = $2`,
      [p2, U_PRODUCER],
    );
    const parent = await createProductionDept({ productionId: p2, name: "技术部" });
    const child = await createProductionDept({ productionId: p2, name: "灯光组", parentId: parent.id });
    childDept = child.id;
    await setDeptMembers(parent.id, p2, [{ userId: U_ANC_POC, isPoc: true }]);
    await setDeptMembers(childDept, p2, [{ userId: U_POC, isPoc: true }]);
    await addResourceDeptManage({
      productionId: p2, deptId: childDept, resourceType: "cue_list", establishedBy: U_OWNER,
    });
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES ($1,$2,'cue_list','*','grants','edit','direct') ON CONFLICT DO NOTHING`,
      [p2, U_HOLDER],
    );
  });

  afterAll(async () => {
    await cleanupProduction(p2).catch(() => {});
  });

  it("PRD 五级顺序：上级 → 持有者 → 共管部门 POC → 父部门 POC → 制作人 → owner", async () => {
    const ladder = await buildApprovalLadder({
      productionId: p2, subjectId: U_REQUESTER,
      resourceType: "cue_list", resourceId: "*", resourceSub: "*", permissionLevel: "view",
    });
    expect(ladder.map((s) => s.stage)).toEqual([
      "supervisor", "holder", "dept_poc", "ancestor_poc", "producer", "owner",
    ]);
    expect(ladder.map((s) => s.approverIds)).toEqual([
      [U_SUPERVISOR], [U_HOLDER], [U_POC], [U_ANC_POC], [U_PRODUCER], [U_OWNER],
    ]);
  });

  it("跨级去重：同一人只在最早的一级出现", async () => {
    // 让父部门 POC 也成为制作人 —— 制作人级应因为已通知过而被跳过
    await getPool().query(
      `UPDATE production_member SET roles = ARRAY['制作人'] WHERE production_id = $1 AND user_id = $2`,
      [p2, U_ANC_POC],
    );
    try {
      const ladder = await buildApprovalLadder({
        productionId: p2, subjectId: U_REQUESTER,
        resourceType: "cue_list", resourceId: "*", resourceSub: "*", permissionLevel: "view",
      });
      const producerStage = ladder.find((s) => s.stage === "producer");
      expect(producerStage?.approverIds).not.toContain(U_ANC_POC);
      expect(ladder.filter((s) => s.approverIds.includes(U_ANC_POC))).toHaveLength(1);
    } finally {
      await getPool().query(
        `UPDATE production_member SET roles = '{}' WHERE production_id = $1 AND user_id = $2`,
        [p2, U_ANC_POC],
      );
    }
  });
});

// ─── 2. submitAccessRequest ───────────────────────────────────────────────────

describe("submitAccessRequest", () => {
  it("有直属上级 → 首级 supervisor，current_approver_ids 写入上级", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    expect(req.status).toBe("pending_supervisor");
    expect(req.currentStage).toBe("supervisor");
    expect(req.currentApproverIds).toEqual([U_SUPERVISOR]);
    expect(req.subjectId).toBe(U_REQUESTER);
    expect(req.productionId).toBe(prodId);

    await cancelRows([req.id]);
  });

  it("无直属上级 → 首级直接落到资源侧", async () => {
    const req = await submitAccessRequest(prodId, U_UNRELATED, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    expect(req.status).toBe("pending_resource");
    expect(req.currentStage).toBe("dept_poc");
    expect(req.currentApproverIds).toEqual([U_POC]);

    await cancelRows([req.id]);
  });

  it("notify: 首级审批人拿到 action_required 通知", async () => {
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
    // 上级无权终局 → 主动作是「转交」而非「批准」
    expect(notifs[0].actions.map((a) => a.id)).toEqual(["escalate", "reject"]);

    await cancelRows([req.id]);
  });

  it("notify: 上级持有该权限时主动作是「批准」", async () => {
    await grantRows(U_SUPERVISOR, [["*", "view"]]);
    try {
      const req = await submitAccessRequest(prodId, U_REQUESTER, {
        resourceType: "cue_list",
        permissionLevel: "view",
      });
      const notifs = await notifForRequest(U_SUPERVISOR, req.id);
      expect(notifs[0].actions.map((a) => a.id)).toEqual(["approve", "reject"]);
      await cancelRows([req.id]);
    } finally {
      await revokeAll(U_SUPERVISOR);
    }
  });

  // #256：'ttl' 不带时长会一路 NULL 到 expires_at，而 NULL 在每一处检查里都等于永久
  it("#256: grantType='ttl' 缺时长 → invalid_ttl，不落库", async () => {
    await expect(
      submitAccessRequest(prodId, U_REQUESTER, {
        resourceType: "cue_list",
        permissionLevel: "view",
        grantType: "ttl",
      }),
    ).rejects.toThrow(ApprovalRequestError);

    const rows = await getPool().query(
      `SELECT 1 FROM approval_request
       WHERE production_id = $1 AND subject_id = $2 AND grant_type = 'ttl' AND ttl_duration IS NULL`,
      [prodId, U_REQUESTER],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("#256: 白名单外的时长同样被拒（只认 TTL_OPTIONS）", async () => {
    await expect(
      submitAccessRequest(prodId, U_REQUESTER, {
        resourceType: "cue_list",
        permissionLevel: "view",
        grantType: "ttl",
        ttlDuration: "99 years",
      }),
    ).rejects.toThrow(ApprovalRequestError);
  });

  it("#256: DB 约束是最后一道 —— 绕过应用层也写不进 ttl+NULL", async () => {
    await expect(
      getPool().query(
        `INSERT INTO approval_request
           (production_id, subject_id, type, resource_type, resource_id, resource_sub,
            permission_level, grant_type, ttl_duration, status)
         VALUES ($1,$2,'resource_access','cue_list','*','*','view','ttl',NULL,'pending_resource')`,
        [prodId, U_REQUESTER],
      ),
    ).rejects.toThrow();
  });

  it("ROOT 节点拒收申请（owner-only，连审批通道都没有）", async () => {
    await expect(
      submitAccessRequest(prodId, U_REQUESTER, {
        resourceType: "production",
        resourceSub: "owner",
        permissionLevel: "edit",
      }),
    ).rejects.toMatchObject({ reason: "no_entry" });
  });

  it("覆盖式申请：同目标的旧 pending 被自动 cancel 且待办过期", async () => {
    // 2026-08-16 用户反馈：先申 1 天 TTL 再申 1 月，旧申请待办堆积审批人收件箱
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
      ttlDuration: "1 mon",
    });

    const firstRow = await getPool().query<{ status: string; resolved_at: Date | null }>(
      `SELECT status, resolved_at FROM approval_request WHERE id = $1`, [first.id]);
    expect(firstRow.rows[0].status).toBe("cancelled");
    expect(firstRow.rows[0].resolved_at).not.toBeNull();

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

    await cancelRows([second.id, editReq.id]);
  });

  it("escalation_chain 首条记录级名、层深与 canFinalize", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    expect(req.escalationChain).toHaveLength(1);
    expect(req.escalationChain[0].phase).toBe("supervisor");
    expect(req.escalationChain[0].stage).toBe("supervisor");
    expect(req.escalationChain[0].depth).toBe(0);
    expect(req.escalationChain[0].canFinalize).toBe(false);
    expect(req.escalationChain[0].approverIds).toContain(U_SUPERVISOR);

    await cancelRows([req.id]);
  });
});

// ─── 3. approveAccessRequest ──────────────────────────────────────────────────

describe("approveAccessRequest — supervisor 级按敏感度/持权分流", () => {
  it("unauthorized: 非当前级审批人不能批", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list", permissionLevel: "view",
    });
    const result = await approveAccessRequest(req.id, U_UNRELATED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");
    await cancelRows([req.id]);
  });

  it("forward_only: 上级本人无该权限 → 批不了，只能转交", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list", permissionLevel: "view",
    });
    const result = await approveAccessRequest(req.id, U_SUPERVISOR);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("forward_only");

    // 申请没被动过
    const row = await getPool().query<{ status: string }>(
      `SELECT status FROM approval_request WHERE id = $1`, [req.id]);
    expect(row.rows[0].status).toBe("pending_supervisor");
    await cancelRows([req.id]);
  });

  it("上级持有该权限 → 批准即终局，直接发授权", async () => {
    await grantRows(U_SUPERVISOR, [["*", "view"]]);
    try {
      const req = await submitAccessRequest(prodId, U_REQUESTER, {
        resourceType: "cue_list", permissionLevel: "view",
      });
      const result = await approveAccessRequest(req.id, U_SUPERVISOR);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.request.status).toBe("approved");

      const grants = await getPool().query(
        `SELECT * FROM production_member_grant WHERE approval_id = $1`, [req.id]);
      expect(grants.rows).toHaveLength(1);
      expect(grants.rows[0].user_id).toBe(U_REQUESTER);
      expect(grants.rows[0].grant_source).toBe("approval");
    } finally {
      await revokeAll(U_SUPERVISOR);
      await revokeAll(U_REQUESTER);
    }
  });

  it("owner 可随时介入批准（越级）", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list", permissionLevel: "view",
    });
    const result = await approveAccessRequest(req.id, U_OWNER);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.status).toBe("approved");
    await revokeAll(U_REQUESTER);
  });

  it("SENSITIVE 申请：制作人代批不了，owner 才能批", async () => {
    await addProductionMember(prodId, U_PRODUCER);
    await getPool().query(
      `UPDATE production_member SET roles = ARRAY['制作人'] WHERE production_id = $1 AND user_id = $2`,
      [prodId, U_PRODUCER],
    );
    try {
      const req = await submitAccessRequest(prodId, U_REQUESTER, {
        resourceType: "production", resourceSub: "meta", permissionLevel: "edit",
      });
      expect(req.currentStage).toBe("owner");
      expect(req.currentApproverIds).toEqual([U_OWNER]);

      const denied = await approveAccessRequest(req.id, U_PRODUCER);
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.reason).toBe("unauthorized");

      const ok = await approveAccessRequest(req.id, U_OWNER);
      expect(ok.ok).toBe(true);
    } finally {
      await getPool().query(
        `DELETE FROM production_member_grant WHERE production_id = $1 AND user_id = $2`,
        [prodId, U_REQUESTER],
      );
      await getPool().query(
        `UPDATE production_member SET roles = '{}' WHERE production_id = $1 AND user_id = $2`,
        [prodId, U_PRODUCER],
      );
    }
  });

  it("非敏感申请：制作人可主动介入批准", async () => {
    await addProductionMember(prodId, U_PRODUCER);
    await getPool().query(
      `UPDATE production_member SET roles = ARRAY['制作人'] WHERE production_id = $1 AND user_id = $2`,
      [prodId, U_PRODUCER],
    );
    try {
      const req = await submitAccessRequest(prodId, U_REQUESTER, {
        resourceType: "cue_list", permissionLevel: "view",
      });
      const result = await approveAccessRequest(req.id, U_PRODUCER);
      expect(result.ok).toBe(true);
    } finally {
      await revokeAll(U_REQUESTER);
      await getPool().query(
        `UPDATE production_member SET roles = '{}' WHERE production_id = $1 AND user_id = $2`,
        [prodId, U_PRODUCER],
      );
    }
  });
});

describe("approveAccessRequest — 资源侧终局", () => {
  let reqId: string;

  beforeAll(async () => {
    // U_UNRELATED 无上级 → 首级即 dept_poc（U_POC）
    const req = await submitAccessRequest(prodId, U_UNRELATED, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    reqId = req.id;
  });

  afterAll(async () => {
    await revokeAll(U_UNRELATED);
  });

  it("unauthorized: 无关用户不能批", async () => {
    const result = await approveAccessRequest(reqId, U_REQUESTER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");
  });

  it("POC 批准 → approved", async () => {
    const result = await approveAccessRequest(reqId, U_POC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.status).toBe("approved");
    expect(result.request.grantedAt).not.toBeNull();
    expect(result.request.currentApproverIds).toEqual([]);
  });

  it("production_member_grant 写入 grant_source='approval' 与 approval_id", async () => {
    const row = await getPool().query(
      `SELECT * FROM production_member_grant WHERE approval_id = $1`, [reqId]);
    expect(row.rows).toHaveLength(1);
    const grant = row.rows[0];
    expect(grant.grant_source).toBe("approval");
    expect(grant.user_id).toBe(U_UNRELATED);
    expect(grant.resource_type).toBe("cue_list");
    expect(grant.permission_level).toBe("view");
    expect(grant.is_revoked).toBe(false);
  });

  it("notify: 申请人收到批准通知", async () => {
    const notifs = await notifForRequest(U_UNRELATED, reqId);
    const approvedNotif = notifs.find((n) => n.kind === "approval_request_result");
    expect(approvedNotif).toBeDefined();
    expect(approvedNotif?.approvalRequestId).toBe(reqId);
  });

  it("notify: 待办通知在批准后全部过期", async () => {
    const notifs = [
      ...(await notifForRequest(U_POC, reqId)),
      ...(await notifForRequest(U_UNRELATED, reqId)),
    ];
    const unexpiredActions = notifs.filter((n) => n.actionRequired && !n.actedAt && !n.expiredAt);
    expect(unexpiredActions).toHaveLength(0);
  });

  it("conflict: 同一申请不能批两次", async () => {
    const result = await approveAccessRequest(reqId, U_POC);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
  });
});

describe("授权发行的行集展开", () => {
  it("伪级别申请（sub='*'）展开为整套动词行集", async () => {
    const req = await submitAccessRequest(prodId, U_UNRELATED, {
      resourceType: "cue_list", permissionLevel: "mount",
    });
    await approveAccessRequest(req.id, U_POC);
    const rows = await getPool().query<{ resource_sub: string; permission_level: string }>(
      `SELECT resource_sub, permission_level FROM production_member_grant WHERE approval_id = $1`,
      [req.id]);
    expect(rows.rows.map((r) => `${r.resource_sub}@${r.permission_level}`).sort())
      .toEqual(["*@view", "mounts@create"]);
    await revokeAll(U_UNRELATED);
  });

  // 动词 'edit' 与伪级别 'edit' 同名：节点键申请若也去查伪级别表，一条
  // cues@edit 会被发成整套 edit 行集（含 *@edit 和 cues@delete）——超发。
  it("节点键申请（sub 具体）只发所申请的那一行，不越权展开", async () => {
    const req = await submitAccessRequest(prodId, U_UNRELATED, {
      resourceType: "cue_list", resourceSub: "cues", permissionLevel: "edit",
    });
    await approveAccessRequest(req.id, U_POC);
    const rows = await getPool().query<{ resource_sub: string; permission_level: string }>(
      `SELECT resource_sub, permission_level FROM production_member_grant WHERE approval_id = $1`,
      [req.id]);
    expect(rows.rows.map((r) => `${r.resource_sub}@${r.permission_level}`)).toEqual(["cues@edit"]);
    await revokeAll(U_UNRELATED);
  });
});

// ─── 4. #256 TTL 回归 ─────────────────────────────────────────────────────────

describe("#256 临时权限确实会过期", () => {
  it("ttl 申请批准后 expires_at 非 NULL，且授权行带同一到期时间", async () => {
    const req = await submitAccessRequest(prodId, U_UNRELATED, {
      resourceType: "cue_list",
      permissionLevel: "view",
      grantType: "ttl",
      ttlDuration: "7 days",
    });
    const result = await approveAccessRequest(req.id, U_POC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.expiresAt).not.toBeNull();

    const grants = await getPool().query<{ expires_at: Date | null }>(
      `SELECT expires_at FROM production_member_grant WHERE approval_id = $1`, [req.id]);
    expect(grants.rows).toHaveLength(1);
    expect(grants.rows[0].expires_at).not.toBeNull();
    // 到期时间落在 7 天后附近（宽松窗口，避免时钟抖动）
    const days = (grants.rows[0].expires_at!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    await revokeAll(U_UNRELATED);
  });

  it("permanent 申请批准后 expires_at 为 NULL", async () => {
    const req = await submitAccessRequest(prodId, U_UNRELATED, {
      resourceType: "cue_list",
      permissionLevel: "view",
      grantType: "permanent",
    });
    const result = await approveAccessRequest(req.id, U_POC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.expiresAt).toBeNull();

    const grants = await getPool().query<{ expires_at: Date | null }>(
      `SELECT expires_at FROM production_member_grant WHERE approval_id = $1`, [req.id]);
    expect(grants.rows[0].expires_at).toBeNull();

    await revokeAll(U_UNRELATED);
  });

  it("TTL 档位表：只认 长期 / 1 天 / 1 周 / 1 月", () => {
    expect(TTL_OPTIONS.map((o) => o.value)).toEqual(["permanent", "1d", "1w", "1mo"]);
    expect(TTL_OPTIONS.map((o) => o.interval)).toEqual([null, "1 day", "7 days", "1 mon"]);
    expect(isValidTtlInterval("1 day")).toBe(true);
    expect(isValidTtlInterval("30 minutes")).toBe(false);
    expect(isValidTtlInterval(null)).toBe(false);
    expect(isValidTtlInterval(undefined)).toBe(false);
    // 回显口径与档位一致（"7天" 是 pg 的规范化输出）
    expect(displayTtlLabel("7天")).toBe("1 周");
    expect(displayTtlLabel("1个月")).toBe("1 月");
    expect(displayTtlLabel(null)).toBeNull();
  });
});

// ─── 5. escalateAccessRequest（转交）──────────────────────────────────────────

describe("escalateAccessRequest — 向上转交", () => {
  it("上级转交 → 推进到下一级并通知，链条目记 escalated/forwarded", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list", permissionLevel: "view",
    });
    const result = await escalateAccessRequest(req.id, U_SUPERVISOR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.status).toBe("pending_resource");
    expect(result.request.currentStage).toBe("dept_poc");
    expect(result.request.currentApproverIds).toEqual([U_POC]);

    const chain = result.request.escalationChain;
    expect(chain).toHaveLength(2);
    expect(chain[0].action).toBe("escalated");
    expect(chain[0].actorId).toBe(U_SUPERVISOR);
    expect(chain[0].escalationReason).toBe("forwarded");
    expect(chain[1].stage).toBe("dept_poc");

    // 新一级收到待办，上级的旧待办已过期
    const pocNotifs = await notifForRequest(U_POC, req.id);
    expect(pocNotifs.some((n) => n.kind === "approval_request_pending" && !n.expiredAt)).toBe(true);
    const supNotifs = await notifForRequest(U_SUPERVISOR, req.id);
    expect(supNotifs.filter((n) => n.actionRequired && !n.actedAt && !n.expiredAt)).toHaveLength(0);

    // 转交后 POC 可以终局
    const approved = await approveAccessRequest(req.id, U_POC);
    expect(approved.ok).toBe(true);
    await revokeAll(U_REQUESTER);
  });

  it("unauthorized: 不在当前级的人不能转交", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list", permissionLevel: "view",
    });
    const result = await escalateAccessRequest(req.id, U_UNRELATED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");
    await cancelRows([req.id]);
  });

  it("no_next_stage: 已在链顶（owner）无法继续转交", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list", permissionLevel: "view",
    });
    await escalateAccessRequest(req.id, U_SUPERVISOR);   // → dept_poc
    await escalateAccessRequest(req.id, U_POC);          // → owner
    const atTop = await getPool().query<{ current_stage: string }>(
      `SELECT current_stage FROM approval_request WHERE id = $1`, [req.id]);
    expect(atTop.rows[0].current_stage).toBe("owner");

    const result = await escalateAccessRequest(req.id, U_OWNER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_next_stage");

    await cancelRows([req.id]);
  });

  it("not_found: 转交不存在的申请", async () => {
    const result = await escalateAccessRequest("00000000-0000-0000-0000-deadbeef0002", U_SUPERVISOR);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });

  it("conflict: 已 resolve 的申请不能转交", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list", permissionLevel: "view",
    });
    await rejectAccessRequest(req.id, U_SUPERVISOR);
    const result = await escalateAccessRequest(req.id, U_SUPERVISOR);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
  });
});

// ─── 6. first-action-wins ─────────────────────────────────────────────────────

describe("first-action-wins", () => {
  it("并发批准只有一个成功，授权行只写一次", async () => {
    // U_UNRELATED 无上级，scene 类型无共管部门 → 首级即 owner
    const req = await submitAccessRequest(prodId, U_UNRELATED, {
      resourceType: "scene",
      permissionLevel: "view",
    });
    expect(req.currentStage).toBe("owner");

    const [r1, r2] = await Promise.all([
      approveAccessRequest(req.id, U_OWNER),
      approveAccessRequest(req.id, U_OWNER),
    ]);

    const okCount = [r1, r2].filter((r) => r.ok).length;
    const conflictCount = [r1, r2].filter((r) => !r.ok && r.reason === "conflict").length;
    expect(okCount).toBe(1);
    expect(conflictCount).toBe(1);

    const grants = await getPool().query(
      `SELECT COUNT(*) AS c FROM production_member_grant WHERE approval_id = $1`, [req.id]);
    expect(parseInt(grants.rows[0].c, 10)).toBe(1);

    await revokeAll(U_UNRELATED);
  });

  it("并发转交只有一个成功（阶梯不会跳两级）", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list", permissionLevel: "view",
    });
    const [r1, r2] = await Promise.all([
      escalateAccessRequest(req.id, U_SUPERVISOR),
      escalateAccessRequest(req.id, U_SUPERVISOR),
    ]);
    expect([r1, r2].filter((r) => r.ok).length).toBe(1);

    const row = await getPool().query<{ current_stage: string }>(
      `SELECT current_stage FROM approval_request WHERE id = $1`, [req.id]);
    expect(row.rows[0].current_stage).toBe("dept_poc");

    await cancelRows([req.id]);
  });
});

// ─── 7. rejectAccessRequest ───────────────────────────────────────────────────

describe("rejectAccessRequest", () => {
  it("上级在 supervisor 级拒绝 → rejected（无权终局也能拒）", async () => {
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
    expect(result.request.currentApproverIds).toEqual([]);
  });

  it("notify: 申请人收到拒绝通知", async () => {
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

  it("notify: 拒绝后审批人的待办过期", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "mount", // 批A：发行时展开为动词行集（view + mounts/create）
    });
    await rejectAccessRequest(req.id, U_SUPERVISOR);

    const notifs = await notifForRequest(U_SUPERVISOR, req.id);
    expect(notifs.filter((n) => n.actionRequired && !n.actedAt && !n.expiredAt)).toHaveLength(0);
  });

  it("unauthorized: 无关用户不能拒绝", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    const result = await rejectAccessRequest(req.id, U_UNRELATED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");

    await cancelRows([req.id]);
  });

  it("POC 在资源级拒绝 → rejected", async () => {
    const req = await submitAccessRequest(prodId, U_UNRELATED, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    expect(req.currentStage).toBe("dept_poc");

    const result = await rejectAccessRequest(req.id, U_POC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.status).toBe("rejected");
  });

  it("conflict: 不能重复拒绝", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    await rejectAccessRequest(req.id, U_SUPERVISOR);
    const result = await rejectAccessRequest(req.id, U_SUPERVISOR);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
  });

  it("not_found: 拒绝不存在的申请", async () => {
    const result = await rejectAccessRequest("00000000-0000-0000-0000-deadbeef0000", U_SUPERVISOR);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });
});

// ─── 8. cancelAccessRequest ───────────────────────────────────────────────────

describe("cancelAccessRequest", () => {
  it("申请人撤回 pending 申请 → cancelled，且清空当前级", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    const result = await cancelAccessRequest(req.id, U_REQUESTER);
    expect(result.ok).toBe(true);

    const row = await getPool().query<{ status: string; current_approver_ids: string[] }>(
      `SELECT status, current_approver_ids FROM approval_request WHERE id = $1`, [req.id]);
    expect(row.rows[0].status).toBe("cancelled");
    expect(row.rows[0].current_approver_ids).toEqual([]);
  });

  it("notify: 撤回后审批人的待办过期", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    await cancelAccessRequest(req.id, U_REQUESTER);

    const notifs = await notifForRequest(U_SUPERVISOR, req.id);
    expect(notifs.filter((n) => n.actionRequired && !n.actedAt && !n.expiredAt)).toHaveLength(0);
  });

  it("conflict: 非申请人不能撤回别人的申请", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    const result = await cancelAccessRequest(req.id, U_UNRELATED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");

    await cancelRows([req.id]);
  });

  it("conflict: 已批准的申请不能撤回", async () => {
    const req = await submitAccessRequest(prodId, U_UNRELATED, {
      resourceType: "cue_list",
      permissionLevel: "view",
    });
    await approveAccessRequest(req.id, U_POC);
    const result = await cancelAccessRequest(req.id, U_UNRELATED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");

    await revokeAll(U_UNRELATED);
  });

  it("not_found: 撤回不存在的申请", async () => {
    const result = await cancelAccessRequest("00000000-0000-0000-0000-deadbeef0001", U_REQUESTER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });
});

// ─── 9. listMyAccessRequests ──────────────────────────────────────────────────

describe("listMyAccessRequests", () => {
  it("只返回本人提交的申请", async () => {
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
    expect(mine.filter((r) => r.subjectId === U_POC)).toHaveLength(0);

    await cancelRows([r1.id, r2.id]);
  });

  it("按时间倒序", async () => {
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

    await cancelRows([r1.id, r2.id]);
  });

  // 2026-08-17：ttl_duration 是 INTERVAL 列，node-postgres 会解析成
  // postgres-interval 对象（'7 days' → { days: 7 }）。裸传到前端会让 React 抛
  // "Objects are not valid as a React child (found: object with keys {days})"。
  it("ttlDurationLabel 恒是字符串，不是 postgres-interval 对象", async () => {
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

    await cancelRows([req.id]);
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

  // 每个 PgInterval 字段都必须有对应单位，否则就是静默丢数据
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

// ─── 10. listPendingApprovals ─────────────────────────────────────────────────

describe("listPendingApprovals", () => {
  let supervisorPendingId: string;
  let resourcePendingId: string;
  let ownerPendingId: string;

  beforeAll(async () => {
    const r1 = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list", permissionLevel: "view",
    });
    supervisorPendingId = r1.id;

    const r2 = await submitAccessRequest(prodId, U_UNRELATED, {
      resourceType: "cue_list", permissionLevel: "view",
    });
    resourcePendingId = r2.id;

    // scene 无共管部门 → 首级即 owner
    const r3 = await submitAccessRequest(prodId, U_UNRELATED, {
      resourceType: "scene", permissionLevel: "view",
    });
    ownerPendingId = r3.id;
  });

  afterAll(async () => {
    await cancelRows([supervisorPendingId, resourcePendingId, ownerPendingId]);
  });

  it("只看得到「当前轮到我」的申请", async () => {
    const supervisorIds = (await listPendingApprovals(U_SUPERVISOR, prodId)).map((r) => r.id);
    expect(supervisorIds).toContain(supervisorPendingId);
    expect(supervisorIds).not.toContain(resourcePendingId);
    expect(supervisorIds).not.toContain(ownerPendingId);

    const pocIds = (await listPendingApprovals(U_POC, prodId)).map((r) => r.id);
    expect(pocIds).toContain(resourcePendingId);
    expect(pocIds).not.toContain(supervisorPendingId);

    const ownerIds = (await listPendingApprovals(U_OWNER, prodId)).map((r) => r.id);
    expect(ownerIds).toContain(ownerPendingId);
  });

  it("canFinalize 随级填充：上级无权时为 false", async () => {
    const mine = await listPendingApprovals(U_SUPERVISOR, prodId);
    const row = mine.find((r) => r.id === supervisorPendingId);
    expect(row?.canFinalize).toBe(false);

    const pocRow = (await listPendingApprovals(U_POC, prodId)).find((r) => r.id === resourcePendingId);
    expect(pocRow?.canFinalize).toBe(true);
  });

  it("无关用户什么都看不到", async () => {
    const pending = await listPendingApprovals(U_HOLDER, prodId);
    const relevant = [supervisorPendingId, resourcePendingId, ownerPendingId];
    expect(pending.filter((r) => relevant.includes(r.id))).toHaveLength(0);
  });

  it("已 resolve 的申请不出现在待办里", async () => {
    const req = await submitAccessRequest(prodId, U_UNRELATED, {
      resourceType: "cue_list", permissionLevel: "edit",
    });
    await approveAccessRequest(req.id, U_POC);

    const ids = (await listPendingApprovals(U_POC, prodId)).map((r) => r.id);
    expect(ids).not.toContain(req.id);

    await revokeAll(U_UNRELATED);
  });
});

// ─── 11. escalateExpiredApprovals ─────────────────────────────────────────────

describe("escalateExpiredApprovals", () => {
  /** 把当前级的通知时刻往前拨，模拟该级超时。 */
  async function backdateCurrentStage(requestId: string, hours: number) {
    await getPool().query(
      `UPDATE approval_request
       SET created_at = now() - ($2 || ' hours')::interval,
           escalation_chain = jsonb_set(
             escalation_chain,
             ARRAY[(jsonb_array_length(escalation_chain) - 1)::text, 'notifiedAt'],
             to_jsonb((now() - ($2 || ' hours')::interval)::text))
       WHERE id = $1`,
      [requestId, String(hours)],
    );
  }

  it("当前级超时 → 推进到下一级并通知", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list", permissionLevel: "view",
    });
    expect(req.currentStage).toBe("supervisor");
    await backdateCurrentStage(req.id, 25);

    const result = await escalateExpiredApprovals();
    expect(result.escalated).toBeGreaterThanOrEqual(1);

    const row = await getPool().query<{ status: string; current_stage: string }>(
      `SELECT status, current_stage FROM approval_request WHERE id = $1`, [req.id]);
    expect(row.rows[0].status).toBe("pending_resource");
    expect(row.rows[0].current_stage).toBe("dept_poc");

    const notifs = await notifForRequest(U_POC, req.id);
    expect(notifs.some((n) => n.kind === "approval_request_pending")).toBe(true);

    await cancelRows([req.id]);
  });

  it("每级各自计时：一次 cron 只跳一级", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list", permissionLevel: "view",
    });
    await backdateCurrentStage(req.id, 25);
    await escalateExpiredApprovals();
    // 新一级的 notifiedAt 是刚才写的 → 不该再被同一次超时窗口带走
    await escalateExpiredApprovals();

    const row = await getPool().query<{ current_stage: string }>(
      `SELECT current_stage FROM approval_request WHERE id = $1`, [req.id]);
    expect(row.rows[0].current_stage).toBe("dept_poc");

    await cancelRows([req.id]);
  });

  it("链顶（owner）超时不再升级", async () => {
    const req = await submitAccessRequest(prodId, U_UNRELATED, {
      resourceType: "scene", permissionLevel: "view",
    });
    expect(req.currentStage).toBe("owner");
    await backdateCurrentStage(req.id, 25);

    await escalateExpiredApprovals();
    const row = await getPool().query<{ current_stage: string; status: string }>(
      `SELECT current_stage, status FROM approval_request WHERE id = $1`, [req.id]);
    expect(row.rows[0].current_stage).toBe("owner");
    expect(row.rows[0].status).toBe("pending_resource");

    await cancelRows([req.id]);
  });

  // 线上教训（2026-08-17）：production_approval_config 是 Phase 3 才加的表，
  // 建表 SQL 没回填，早于它的演出一行都没有——线上 8 个演出全部缺行。原先的
  // INNER JOIN 让这些演出的申请永远匹配不上，整条升级链从未生效过。
  //
  // 这条用例必须**显式删掉配置行**才测得到：工厂造的演出恒有配置行
  // （createProduction 会插），fixture 再插一遍，两层都把线上的真实前提盖住了。
  it("演出没有审批配置行时，按列默认值 24h 计时而非永不升级", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list", permissionLevel: "view",
    });
    await getPool().query(
      `DELETE FROM production_approval_config WHERE production_id = $1`, [prodId]);
    try {
      await backdateCurrentStage(req.id, 25);
      await escalateExpiredApprovals();

      const row = await getPool().query<{ current_stage: string }>(
        `SELECT current_stage FROM approval_request WHERE id = $1`, [req.id]);
      expect(row.rows[0].current_stage).toBe("dept_poc");
    } finally {
      await getPool().query(
        `INSERT INTO production_approval_config (production_id, ttl_hours, updated_by)
         VALUES ($1, 24, $2) ON CONFLICT DO NOTHING`, [prodId, U_OWNER]);
      await cancelRows([req.id]);
    }
  });

  it("缺配置行且未超过默认 24h 的申请不动", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list", permissionLevel: "view",
    });
    await getPool().query(
      `DELETE FROM production_approval_config WHERE production_id = $1`, [prodId]);
    try {
      await backdateCurrentStage(req.id, 2);
      await escalateExpiredApprovals();
      const row = await getPool().query<{ current_stage: string }>(
        `SELECT current_stage FROM approval_request WHERE id = $1`, [req.id]);
      expect(row.rows[0].current_stage).toBe("supervisor");
    } finally {
      await getPool().query(
        `INSERT INTO production_approval_config (production_id, ttl_hours, updated_by)
         VALUES ($1, 24, $2) ON CONFLICT DO NOTHING`, [prodId, U_OWNER]);
      await cancelRows([req.id]);
    }
  });

  it("未超时的申请不动", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list", permissionLevel: "view",
    });
    const before = await getPool().query<{ current_stage: string }>(
      `SELECT current_stage FROM approval_request WHERE id = $1`, [req.id]);
    await escalateExpiredApprovals();
    const after = await getPool().query<{ current_stage: string }>(
      `SELECT current_stage FROM approval_request WHERE id = $1`, [req.id]);
    expect(after.rows[0].current_stage).toBe(before.rows[0].current_stage);

    await cancelRows([req.id]);
  });
});

// ─── 12. 回填脚本 ─────────────────────────────────────────────────────────────

describe("add-approval-config-backfill.sql", () => {
  /** 直接跑仓库里的那份 SQL——测的是要部署的文件本身，不是它的副本。 */
  async function runBackfill() {
    const sql = await readFile(path.join(process.cwd(), "db/add-approval-config-backfill.sql"), "utf8");
    await getPool().query(sql);
  }

  it("补齐缺行的演出，重复执行不产生重复行", async () => {
    await getPool().query(
      `DELETE FROM production_approval_config WHERE production_id = $1`, [prodId]);

    await runBackfill();
    await runBackfill();  // 幂等：第二次不该炸也不该多插

    const rows = await getPool().query<{ ttl_hours: number; updated_by: string | null }>(
      `SELECT ttl_hours, updated_by FROM production_approval_config WHERE production_id = $1`,
      [prodId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].ttl_hours).toBe(24);
    // updated_by 留 NULL = 从未被人工修改
    expect(rows.rows[0].updated_by).toBeNull();
  });

  it("不覆盖已有配置：制作人调过的 TTL 必须原样保留", async () => {
    await getPool().query(
      `INSERT INTO production_approval_config (production_id, ttl_hours, updated_by)
       VALUES ($1, 72, $2)
       ON CONFLICT (production_id) DO UPDATE SET ttl_hours = 72, updated_by = EXCLUDED.updated_by`,
      [prodId, U_OWNER]);

    await runBackfill();

    const rows = await getPool().query<{ ttl_hours: number; updated_by: string | null }>(
      `SELECT ttl_hours, updated_by FROM production_approval_config WHERE production_id = $1`,
      [prodId]);
    expect(rows.rows[0].ttl_hours).toBe(72);
    expect(rows.rows[0].updated_by).toBe(U_OWNER);

    // 复原，免得影响后面按 24h 计时的用例
    await getPool().query(
      `UPDATE production_approval_config SET ttl_hours = 24, updated_by = $2 WHERE production_id = $1`,
      [prodId, U_OWNER]);
  });
});

// ─── 13. 端到端 ───────────────────────────────────────────────────────────────

describe("full happy path — 上级转交 → POC 批准", () => {
  it("提交 → 上级转交 → POC 批准 → 授权行写入、通知齐备", async () => {
    const req = await submitAccessRequest(prodId, U_REQUESTER, {
      resourceType: "cue_list",
      permissionLevel: "mount", // 批A：发行时展开为动词行集（view + mounts/create）
      grantType: "permanent",
      note: "端到端测试",
    });
    expect(req.status).toBe("pending_supervisor");

    // Step 1：上级没有这个权限，只能转交
    const denied = await approveAccessRequest(req.id, U_SUPERVISOR);
    expect(denied.ok).toBe(false);
    const step1 = await escalateAccessRequest(req.id, U_SUPERVISOR);
    expect(step1.ok).toBe(true);
    if (!step1.ok) return;
    expect(step1.request.status).toBe("pending_resource");

    const pocNotifs1 = await notifForRequest(U_POC, req.id);
    expect(pocNotifs1.some((n) => n.kind === "approval_request_pending")).toBe(true);

    // Step 2：POC 批准
    const step2 = await approveAccessRequest(req.id, U_POC);
    expect(step2.ok).toBe(true);
    if (!step2.ok) return;
    expect(step2.request.status).toBe("approved");

    // 批A：mount 伪级别展开为 2 行动词行集（'*'@view + mounts@create）
    const grant = await getPool().query(
      `SELECT * FROM production_member_grant WHERE approval_id = $1`, [req.id]);
    expect(grant.rows).toHaveLength(2);
    const subs = grant.rows
      .map((r: { resource_sub: string; permission_level: string }) => `${r.resource_sub}@${r.permission_level}`)
      .sort();
    expect(subs).toEqual(["*@view", "mounts@create"]);
    expect(grant.rows[0].user_id).toBe(U_REQUESTER);
    expect(grant.rows.every((r: { is_revoked: boolean }) => !r.is_revoked)).toBe(true);

    const requesterNotifs = await notifForRequest(U_REQUESTER, req.id);
    expect(requesterNotifs.some((n) => n.kind === "approval_request_result")).toBe(true);

    const allRelated = [
      ...(await notifForRequest(U_SUPERVISOR, req.id)),
      ...(await notifForRequest(U_POC, req.id)),
    ];
    expect(allRelated.filter((n) => n.actionRequired && !n.actedAt && !n.expiredAt)).toHaveLength(0);

    await revokeAll(U_REQUESTER);
  });
});
