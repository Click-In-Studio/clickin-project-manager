import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import {
  addProductionMember,
  approveAccessRequest,
  escalateAccessRequest,
  escalateExpiredApprovals,
  getAccessRequestFlow,
  rejectAccessRequest,
  submitAccessRequest,
} from "@/lib/db";
import { createFlowTemplate, publishFlowTemplate, updateFlowTemplate } from "@/lib/approval-flow-template-db";
import type { ApprovalTemplateNode } from "@/lib/approval-flow-template";
import { makeProduction, cleanupProduction } from "./factories";

// 模版流引擎（prB，lib/approval-flow-engine.ts）端到端：
// 提交编译快照 → 逐节点推进（cc 到达即投递、跳过/owner 兜底）→ 终局发行；
// 节点内转交/超时、拒绝、实例流程视图（P1-6）、无模版回退阶梯。
// 阶梯路径的零回归由 tests/approval-flow.test.ts 的既有套件把守——本文件不重测。

const U_OWNER    = "00000000-0000-0000-0007-000000000001";
const U_SUBJECT  = "00000000-0000-0000-0007-000000000002";
const U_APPROVER = "00000000-0000-0000-0007-000000000003";
const U_CC       = "00000000-0000-0000-0007-000000000004";
const U_PROC     = "00000000-0000-0000-0007-000000000005";
const U_OTHER    = "00000000-0000-0000-0007-000000000006";

const ALL_USERS = [
  { id: U_OWNER,    name: "引擎Owner" },
  { id: U_SUBJECT,  name: "引擎申请人" },
  { id: U_APPROVER, name: "引擎审批人" },
  { id: U_CC,       name: "引擎抄送人" },
  { id: U_PROC,     name: "引擎处理人" },
  { id: U_OTHER,    name: "引擎无关成员" },
];

let prodId: string;

const NODES: ApprovalTemplateNode[] = [
  {
    id: "n-approve", type: "approval", title: "指定审批",
    assigneeSource: "specific_members", memberIds: [U_APPROVER],
    decisionMode: "any", timeoutHours: 24, optional: false,
  },
  {
    id: "n-cc", type: "cc", title: "抄送观察员",
    assigneeSource: "specific_members", memberIds: [U_CC],
    timeoutHours: null, optional: true,
  },
  {
    id: "n-proc", type: "processing", title: "资源开通",
    assigneeSource: "specific_members", memberIds: [U_PROC],
    timeoutHours: 8, optional: false,
  },
];

async function publishNodes(nodes: ApprovalTemplateNode[]): Promise<string> {
  const created = await createFlowTemplate(prodId, U_OWNER, { name: "引擎测试模版", nodes });
  if (!created.ok) throw new Error(`template create failed: ${JSON.stringify(created)}`);
  const pub = await publishFlowTemplate(prodId, created.template.id, U_OWNER);
  if (!pub.ok) throw new Error("publish failed");
  return created.template.id;
}

async function submit() {
  return submitAccessRequest(prodId, U_SUBJECT, {
    resourceType: "cue_list", resourceId: "*", permissionLevel: "view",
  });
}

beforeAll(async () => {
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_user (id) SELECT * FROM UNNEST($1::uuid[]) ON CONFLICT DO NOTHING`,
    [ALL_USERS.map((u) => u.id)],
  );
  await pool.query(
    `INSERT INTO user_profile (user_id, name)
     SELECT * FROM UNNEST($1::uuid[], $2::text[])
     ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name`,
    [ALL_USERS.map((u) => u.id), ALL_USERS.map((u) => u.name)],
  );
  ({ prodId } = await makeProduction(U_OWNER));
  for (const u of [U_SUBJECT, U_APPROVER, U_CC, U_PROC, U_OTHER]) {
    await addProductionMember(prodId, u);
  }
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("模版流端到端", () => {
  let templateId: string;

  it("提交时编译快照：结构定格、首节点晚绑定解析", async () => {
    templateId = await publishNodes(NODES);
    const req = await submit();

    expect(req.flowSnapshot).not.toBeNull();
    expect(req.flowSnapshot!.templateId).toBe(templateId);
    expect(req.flowSnapshot!.cursor).toBe(0);
    expect(req.flowSnapshot!.nodes[0].state).toBe("active");
    expect(req.flowSnapshot!.nodes[0].resolvedApproverIds).toEqual([U_APPROVER]);
    expect(req.currentApproverIds).toEqual([U_APPROVER]);
    expect(req.status).toBe("pending_resource");
    expect(req.currentStage).toBeNull();
  });

  it("审批节点完成 → cc 到达即投递 → 停在处理节点，不终局", async () => {
    const req = await submit();
    const r1 = await approveAccessRequest(req.id, U_APPROVER, "同意");
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const after = r1.request;
    expect(after.status).toBe("pending_resource");
    const snap = after.flowSnapshot!;
    expect(snap.cursor).toBe(2);
    expect(snap.nodes[0].state).toBe("done");
    expect(snap.nodes[0].responses?.[0]).toMatchObject({ userId: U_APPROVER, action: "approved", comment: "同意" });
    expect(snap.nodes[1].state).toBe("done");
    expect(snap.nodes[1].deliveredTo).toEqual([U_CC]);
    expect(snap.nodes[2].state).toBe("active");
    expect(after.currentApproverIds).toEqual([U_PROC]);

    // 抄送落 inbox：知会不索动作
    const cc = await getPool().query(
      `SELECT action_required FROM user_notification
       WHERE user_id = $1 AND approval_request_id = $2 AND kind = 'approval_request_cc'`,
      [U_CC, req.id],
    );
    expect(cc.rows).toHaveLength(1);
    expect(cc.rows[0].action_required).toBe(false);

    // 处理节点完成 → 终局 + 发行
    const r2 = await approveAccessRequest(req.id, U_PROC);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.request.status).toBe("approved");
    expect(r2.request.flowSnapshot!.nodes[2].responses?.[0]).toMatchObject({ userId: U_PROC, action: "completed" });

    const grants = await getPool().query(
      `SELECT 1 FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2 AND resource_type = 'cue_list'
         AND approval_id = $3 AND NOT is_revoked`,
      [prodId, U_SUBJECT, req.id],
    );
    expect(grants.rows.length).toBeGreaterThan(0);
  });

  it("非当前处理人不能推进节点；拒绝即整体终局", async () => {
    const req = await submit();
    const bad = await approveAccessRequest(req.id, U_OTHER);
    expect(bad).toMatchObject({ ok: false, reason: "unauthorized" });

    const rej = await rejectAccessRequest(req.id, U_APPROVER, "不批");
    expect(rej.ok).toBe(true);
    if (!rej.ok) return;
    expect(rej.request.status).toBe("rejected");
  });

  it("手动转交是节点内事件：处理人换 owner、节点不换；owner 手上无处可转", async () => {
    const req = await submit();
    const fwd = await escalateAccessRequest(req.id, U_APPROVER, "请 owner 决定");
    expect(fwd.ok).toBe(true);
    if (!fwd.ok) return;
    expect(fwd.request.currentApproverIds).toEqual([U_OWNER]);
    expect(fwd.request.flowSnapshot!.cursor).toBe(0);
    expect(fwd.request.flowSnapshot!.nodes[0].ownerFallback).toBe(true);

    const again = await escalateAccessRequest(req.id, U_OWNER);
    expect(again).toMatchObject({ ok: false, reason: "no_next_stage" });

    // owner 批准完成节点 → 推进到处理节点
    const ok = await approveAccessRequest(req.id, U_OWNER);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.request.currentApproverIds).toEqual([U_PROC]);
  });

  it("超时（不可跳过节点）：cron 按节点 timeoutHours 选行并转交 owner", async () => {
    const req = await submit();
    // 把链末条 notifiedAt 拨回 25h 前（节点 timeout 24h）
    await getPool().query(
      `UPDATE approval_request
       SET escalation_chain = jsonb_set(
             escalation_chain,
             ARRAY[(jsonb_array_length(escalation_chain) - 1)::text, 'notifiedAt'],
             to_jsonb((now() - interval '25 hours')::text))
       WHERE id = $1`,
      [req.id],
    );
    await escalateExpiredApprovals();

    const after = await getPool().query<{ current_approver_ids: string[] }>(
      `SELECT current_approver_ids FROM approval_request WHERE id = $1`,
      [req.id],
    );
    expect(after.rows[0].current_approver_ids).toEqual([U_OWNER]);
    // 清场：别把 pending 行留给后面的 cron 测试
    await rejectAccessRequest(req.id, U_OWNER);
  });

  it("实例流程视图（P1-6）：可见性、预测、动作", async () => {
    const req = await submit();

    // 无关成员（非链上参与者）不可见
    const denied = await getAccessRequestFlow(req.id, U_OTHER, false);
    expect(denied).toMatchObject({ ok: false, reason: "forbidden" });

    // 当前处理人可见：预测只含未走到的非 cc 节点，人按当前组织关系现算
    const view = await getAccessRequestFlow(req.id, U_APPROVER, false);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.view.flow.mode).toBe("template");
    if (view.view.flow.mode !== "template") return;
    expect(view.view.flow.prediction).toEqual([{ nodeId: "n-proc", approverIds: [U_PROC] }]);
    expect(view.view.viewerActions).toMatchObject({ canApprove: true, canReject: true, canEscalate: true });

    // 申请人可见但无动作
    const subjectView = await getAccessRequestFlow(req.id, U_SUBJECT, false);
    expect(subjectView.ok).toBe(true);
    if (!subjectView.ok) return;
    expect(subjectView.view.viewerActions.canApprove).toBe(false);
    await rejectAccessRequest(req.id, U_APPROVER);
  });
});

describe("编译源选择与兜底", () => {
  it("可跳过节点解析为空 → 跳过；全部不可等待 → 退回阶梯路径", async () => {
    const tid = await publishNodes([
      {
        id: "ghost", type: "approval", title: "幽灵角色审批",
        assigneeSource: "project_role", roleNames: ["不存在的角色"],
        decisionMode: "any", timeoutHours: 24, optional: true,
      },
      NODES[0],
    ]);
    const req = await submit();
    expect(req.flowSnapshot!.nodes[0].state).toBe("skipped");
    expect(req.flowSnapshot!.nodes[0].skippedReason).toBe("empty_assignees");
    expect(req.currentApproverIds).toEqual([U_APPROVER]);
    await rejectAccessRequest(req.id, U_APPROVER);

    // 唯一节点解析为空且可跳过 → 无可等待节点 → prepareTemplateFlow 拒绝接手，走阶梯
    await updateFlowTemplate(prodId, tid, U_OWNER, {
      nodes: [{
        id: "ghost-only", type: "approval", title: "幽灵角色审批",
        assigneeSource: "project_role", roleNames: ["不存在的角色"],
        decisionMode: "any", timeoutHours: 24, optional: true,
      }],
    });
    const ladderReq = await submit();
    expect(ladderReq.flowSnapshot).toBeNull();
    expect(ladderReq.currentStage).not.toBeNull();
    await rejectAccessRequest(ladderReq.id, U_OWNER);
  });

  it("不可跳过节点解析为空 → owner 兜底进场", async () => {
    const created = await createFlowTemplate(prodId, U_OWNER, {
      name: "兜底模版",
      nodes: [{
        id: "ghost-required", type: "approval", title: "幽灵角色审批",
        assigneeSource: "project_role", roleNames: ["不存在的角色"],
        decisionMode: "any", timeoutHours: 24, optional: false,
      }],
    });
    if (!created.ok) throw new Error("create failed");
    await publishFlowTemplate(prodId, created.template.id, U_OWNER);

    const req = await submit();
    expect(req.flowSnapshot).not.toBeNull();
    expect(req.currentApproverIds).toEqual([U_OWNER]);
    expect(req.flowSnapshot!.nodes[0].ownerFallback).toBe(true);
    await rejectAccessRequest(req.id, U_OWNER);
  });

  it("退回草稿后无使用中模版 → 新申请走阶梯（存量模版行为不受影响）", async () => {
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM approval_flow_template WHERE production_id = $1 AND status = 'published'`,
      [prodId],
    );
    for (const r of rows) await updateFlowTemplate(prodId, r.id, U_OWNER, { status: "draft" });

    const req = await submit();
    expect(req.flowSnapshot).toBeNull();
    expect(req.currentStage).not.toBeNull();
    await rejectAccessRequest(req.id, U_OWNER);
  });
});
