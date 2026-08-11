import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { myCallTimes, myTechReqs, myFollowedEvents, myMilestones, myProductions } from "@/lib/mcp/my-tools";

// my.* 只读工具的 self-scope 测试：工厂用户 + 一个 production 成员关系。
// 通告/需求/活动无工厂（依赖 event 体系），空态消息即验证了 SQL 正确
// 执行且按 userId 收窄；myProductions 走有数据路径。

let prodId: string;
let userId: string;

beforeAll(async () => {
  userId = (await upsertFeishuUser(`test-open-${shortId()}`, `测试用户${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(userId));
  await addProductionMember(prodId, userId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("my.* read tools", () => {
  it("myProductions lists the factory production with roles", async () => {
    const out = await myProductions(userId);
    expect(out).toContain("《");
    expect(out).not.toContain("当前没有");
  });

  it("empty-state paths execute cleanly and stay self-scoped", async () => {
    expect(await myCallTimes(userId)).toContain("当前没有");
    expect(await myTechReqs(userId)).toContain("当前没有");
    expect(await myFollowedEvents(userId)).toContain("当前没有");
    expect(await myMilestones(userId)).toContain("当前没有");
  });

  it("unknown user gets not-found (profile-gated tools), empty (list tools)", async () => {
    const ghost = "00000000-0000-0000-0000-000000000000";
    expect(await myMilestones(ghost)).toContain("没有找到");
    expect(await myProductions(ghost)).toContain("没有找到");
    expect(await myCallTimes(ghost)).toContain("当前没有");
  });
});
