import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { buildUserContextMarkdown, querySelfSensitive } from "@/lib/agent-tools/user-context";

// 用户信息层测试。当前语义（用户定的边界）：
//   - system prompt 档案 = 自己的基础信息（姓名/管理员/参与制作）
//   - 工具查询只有 querySelfSensitive（查自己的联系方式；确认门在插件层）
//   - 没有"查他人"路径——sessionKey 尚无 production 维度，跨成员查询
//     没有权限语境，等 production 环境落地后再加

let prodId: string;
let callerId: string;
let callerName: string;

beforeAll(async () => {
  callerName = `测试甲${shortId()}`;
  callerId = (await upsertFeishuUser(`test-open-${shortId()}`, callerName, null, false)).userId;
  ({ prodId } = await makeProduction(callerId));
  // 可见性按 production_member 判定（owner 行不自动算成员），工厂显式补齐
  await addProductionMember(prodId, callerId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("buildUserContextMarkdown", () => {
  it("contains name, admin flag and production membership", async () => {
    const md = await buildUserContextMarkdown(callerId);
    expect(md).toBeTruthy();
    expect(md!).toContain("## 当前用户");
    expect(md!).toContain(callerName);
    expect(md!).toContain("平台管理员：否");
    expect(md!).toContain("参与制作");
  });

  it("unknown user yields null", async () => {
    expect(await buildUserContextMarkdown("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("querySelfSensitive（只查自己）", () => {
  it("returns own contact fields (factory user has none registered)", async () => {
    const out = await querySelfSensitive(callerId);
    expect(out).toContain(callerName);
    expect(out).toContain("邮箱");
    expect(out).toContain("电话");
    expect(out).toContain("未登记"); // 工厂用户无联系方式
  });

  it("unknown caller gets a not-found message, not someone else's data", async () => {
    const out = await querySelfSensitive("00000000-0000-0000-0000-000000000000");
    expect(out).toContain("没有找到");
  });
});
