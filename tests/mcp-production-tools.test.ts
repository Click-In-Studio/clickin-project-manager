import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember, createMilestone } from "@/lib/db";
import { createUserNotification } from "@/lib/inbox-db";
import {
  productionInfo,
  productionMyRole,
  productionNotifications,
  productionMilestones,
  DENIED_NOT_MEMBER,
} from "@/lib/mcp/production-tools";

// production.* 与 my.* 的语义分界测试：项目查询的权限门在前——
// 非成员是明确的"权限被拒绝"，不是空结果；成员查询正常返回。

let prodId: string;
let memberId: string;
let outsiderId: string;
let adminOutsiderId: string;
let memberName: string;

beforeAll(async () => {
  memberName = `项目甲${shortId()}`;
  memberId = (await upsertFeishuUser(`test-open-${shortId()}`, memberName, null, false)).userId;
  outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `项目乙${shortId()}`, null, false)).userId;
  adminOutsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `平台管理员${shortId()}`, null, true)).userId;
  ({ prodId } = await makeProduction(memberId));
  await addProductionMember(prodId, memberId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("权限门语义（非成员 = 明确拒绝，不是空结果）", () => {
  it("all four production tools deny non-members explicitly", async () => {
    expect(await productionInfo(outsiderId, prodId)).toBe(DENIED_NOT_MEMBER);
    expect(await productionMyRole(outsiderId, prodId)).toBe(DENIED_NOT_MEMBER);
    expect(await productionNotifications(outsiderId, prodId)).toBe(DENIED_NOT_MEMBER);
    expect(await productionMilestones(outsiderId, prodId)).toBe(DENIED_NOT_MEMBER);
  });

  // 锁定意图行为：getProductionPermissionContext 内置的 isAdmin 旁路与线上
  // production/[id] 等 API 同一份口径，非本工具新增——平台管理员即使不是
  // production_member 行也应通过门，而不是被误当成"非成员"拒绝。
  it("platform admin who is not a member still passes the gate (site-wide admin bypass)", async () => {
    expect(await productionInfo(adminOutsiderId, prodId)).not.toBe(DENIED_NOT_MEMBER);
    expect(await productionMyRole(adminOutsiderId, prodId)).not.toBe(DENIED_NOT_MEMBER);
    expect(await productionNotifications(adminOutsiderId, prodId)).not.toBe(DENIED_NOT_MEMBER);
    expect(await productionMilestones(adminOutsiderId, prodId)).not.toBe(DENIED_NOT_MEMBER);
  });
});

describe("成员查询", () => {
  it("production.info returns name/owner (member-public info)", async () => {
    const out = await productionInfo(memberId, prodId);
    expect(out).toContain("《");
    expect(out).toContain(`所有者：${memberName}`); // 工厂 owner = member 本人
    expect(out).not.toContain("权限被拒绝");
  });

  it("production.my_role returns roles and dept placeholder", async () => {
    const out = await productionMyRole(memberId, prodId);
    expect(out).toContain("职位：");
    expect(out).toContain("部门：");
  });

  it("production.notifications lists own notifications in this production only", async () => {
    await createUserNotification({
      userId: memberId,
      productionId: prodId,
      kind: "test",
      entityType: "test",
      entityId: shortId(),
      title: "项目内通知测试",
      body: "正文",
      category: "info",
    });
    const out = await productionNotifications(memberId, prodId);
    expect(out).toContain("项目内通知测试");
  });

  it("production.milestones lists all milestones with past marker", async () => {
    await createMilestone(shortId(), prodId, "测试里程碑甲", "2020-01-01", 0);
    await createMilestone(shortId(), prodId, "测试里程碑乙", "2099-12-31", 1);
    const out = await productionMilestones(memberId, prodId);
    expect(out).toContain("测试里程碑甲");
    expect(out).toContain("（已过）");
    expect(out).toContain("测试里程碑乙");
  });
});
