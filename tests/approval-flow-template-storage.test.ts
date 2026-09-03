import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/db";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { validateTemplateNodes, type ApprovalTemplateNode } from "@/lib/approval-flow-template";
import {
  createFlowTemplate,
  deleteFlowTemplate,
  getFlowTemplate,
  listFlowTemplates,
  publishFlowTemplate,
  updateFlowTemplate,
} from "@/lib/approval-flow-template-db";

// 审批流程模版存储层（prA，db/add-approval-flow-template.sql）：
// 词表白名单校验、CRUD、发布切换（单一 published 不变量）、仅草稿可删。
// 引擎语义（prB）不在此测——本层只存不驱动。

let prodId: string;
let userId: string;

const validNodes: ApprovalTemplateNode[] = [
  {
    id: "n-supervisor", type: "approval", title: "直属上级审批",
    assigneeSource: "supervisor", decisionMode: "any", timeoutHours: 24, optional: true,
  },
  {
    id: "n-cc", type: "cc", title: "抄送项目管理",
    assigneeSource: "project_role", roleNames: ["制作人"], timeoutHours: null, optional: true,
  },
  {
    id: "n-provision", type: "processing", title: "资源开通",
    assigneeSource: "holder", timeoutHours: 8, optional: false,
  },
];

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  userId = (await upsertFeishuUser(`test-open-${shortId()}`, `模版编辑者-${shortId()}`, null, false)).userId;
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("validateTemplateNodes 白名单", () => {
  it("合法节点数组通过", () => {
    expect(validateTemplateNodes(validNodes)).toEqual([]);
  });

  it("拒绝空数组与纯抄送模版", () => {
    expect(validateTemplateNodes([])).not.toEqual([]);
    expect(validateTemplateNodes([validNodes[1]])).toContainEqual(
      expect.stringContaining("至少需要一个审批或处理节点"),
    );
  });

  it("拒绝 v1 不支持的 decisionMode 与非审批节点的残留 decisionMode", () => {
    const all = [{ ...validNodes[0], decisionMode: "all" }];
    expect(validateTemplateNodes(all).join()).toContain("decisionMode 暂不支持");
    const stale = [validNodes[0], { ...validNodes[2], decisionMode: "any" }];
    expect(validateTemplateNodes(stale).join()).toContain("不接受 decisionMode");
  });

  it("拒绝重复 node id、越界超时、来源缺参", () => {
    const dup = [validNodes[0], { ...validNodes[2], id: "n-supervisor" }];
    expect(validateTemplateNodes(dup).join()).toContain("重复");
    const badTimeout = [{ ...validNodes[0], timeoutHours: 721 }];
    expect(validateTemplateNodes(badTimeout).join()).toContain("timeoutHours");
    const noMembers = [{ ...validNodes[0], assigneeSource: "specific_members" }];
    expect(validateTemplateNodes(noMembers).join()).toContain("memberIds");
    const noRoles = [{ ...validNodes[0], assigneeSource: "project_role" }];
    expect(validateTemplateNodes(noRoles).join()).toContain("roleNames");
  });

  it("拒绝抄送节点带超时", () => {
    const ccTimeout = [validNodes[0], { ...validNodes[1], timeoutHours: 4 }];
    expect(validateTemplateNodes(ccTimeout).join()).toContain("抄送节点不等待");
  });
});

describe("存储层 CRUD 与发布切换", () => {
  it("创建为草稿，非法节点被拒", async () => {
    const bad = await createFlowTemplate(prodId, userId, { name: "坏模版", nodes: [] });
    expect(bad.ok).toBe(false);

    const created = await createFlowTemplate(prodId, userId, {
      name: "标准资源权限", description: "日常协作", resourceScope: "Cue 表", nodes: validNodes,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.template.status).toBe("draft");
    expect(created.template.id).toMatch(/^aft_/);
    expect(created.template.nodes).toHaveLength(3);
  });

  it("PATCH 改内容；status 只接受 draft", async () => {
    const created = await createFlowTemplate(prodId, userId, { name: "待改", nodes: validNodes });
    if (!created.ok) throw new Error("factory create failed");
    const tid = created.template.id;

    const renamed = await updateFlowTemplate(prodId, tid, userId, { name: "已改名" });
    expect(renamed.ok && renamed.template.name).toBe("已改名");

    const badStatus = await updateFlowTemplate(prodId, tid, userId, { status: "published" });
    expect(badStatus.ok).toBe(false);

    const badNodes = await updateFlowTemplate(prodId, tid, userId, { nodes: [{ junk: true }] });
    expect(badNodes.ok).toBe(false);
  });

  it("发布切换：新发布自动把旧 published 降回草稿（单一使用中）", async () => {
    const a = await createFlowTemplate(prodId, userId, { name: "流程A", nodes: validNodes });
    const b = await createFlowTemplate(prodId, userId, { name: "流程B", nodes: validNodes });
    if (!a.ok || !b.ok) throw new Error("factory create failed");

    const pubA = await publishFlowTemplate(prodId, a.template.id, userId);
    expect(pubA.ok && pubA.template.status).toBe("published");

    const pubB = await publishFlowTemplate(prodId, b.template.id, userId);
    expect(pubB.ok && pubB.template.status).toBe("published");

    const afterA = await getFlowTemplate(prodId, a.template.id);
    expect(afterA?.status).toBe("draft");

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM approval_flow_template
       WHERE production_id = $1 AND status = 'published'`,
      [prodId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("published 不可删；转回草稿后可删", async () => {
    const t = await createFlowTemplate(prodId, userId, { name: "待删", nodes: validNodes });
    if (!t.ok) throw new Error("factory create failed");
    const tid = t.template.id;

    await publishFlowTemplate(prodId, tid, userId);
    const blocked = await deleteFlowTemplate(prodId, tid);
    expect(blocked).toEqual({ ok: false, reason: "published" });

    await updateFlowTemplate(prodId, tid, userId, { status: "draft" });
    expect(await deleteFlowTemplate(prodId, tid)).toEqual({ ok: true });
    expect(await getFlowTemplate(prodId, tid)).toBeNull();
  });

  it("列表按项目隔离", async () => {
    const { prodId: otherProd } = await makeProduction();
    try {
      const mine = await listFlowTemplates(prodId);
      expect(mine.length).toBeGreaterThan(0);
      expect(await listFlowTemplates(otherProd)).toHaveLength(0);
    } finally {
      await cleanupProduction(otherProd).catch(() => {});
    }
  });
});
