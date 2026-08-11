import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { faker } from "@faker-js/faker";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { buildUserContextMarkdown, queryUsers, queryUserSensitive } from "@/lib/mcp/user-context";

// 用户信息层的可见性边界测试：
//   caller 只能看到与自己共享 production 的成员；
//   基础查询不含联系方式，敏感查询含（经确认门后才会被调用到）。

let prodShared: string;
let prodOther: string;
let callerId: string;
let mateName: string;
let outsiderName: string;

beforeAll(async () => {
  const mkUser = async (name: string) =>
    (await upsertFeishuUser(`test-open-${shortId()}`, name, null, false)).userId;

  callerId = await mkUser(`测试甲${shortId()}`);
  mateName = `测试乙${shortId()}`;
  const mateId = await mkUser(mateName);
  outsiderName = `测试丙${shortId()}`;
  const outsiderId = await mkUser(outsiderName);

  ({ prodId: prodShared } = await makeProduction(callerId));
  // 可见性按 production_member 判定（owner 行不自动算成员——真实创建
  // 流程由 API 层补 member 行），工厂数据显式补齐
  await addProductionMember(prodShared, callerId);
  await addProductionMember(prodShared, mateId);

  ({ prodId: prodOther } = await makeProduction(outsiderId));
  await addProductionMember(prodOther, outsiderId);
  void faker; // seed determinism initialized in setup
});

afterAll(async () => {
  await cleanupProduction(prodShared).catch(() => {});
  await cleanupProduction(prodOther).catch(() => {});
});

describe("buildUserContextMarkdown", () => {
  it("contains name, admin flag and production membership", async () => {
    const md = await buildUserContextMarkdown(callerId);
    expect(md).toBeTruthy();
    expect(md!).toContain("## 当前用户");
    expect(md!).toContain("测试甲");
    expect(md!).toContain("平台管理员：否");
    expect(md!).toContain("参与制作");
  });

  it("unknown user yields null", async () => {
    expect(await buildUserContextMarkdown("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("queryUsers（基础信息，可见性收窄）", () => {
  it("finds a member sharing a production", async () => {
    const out = await queryUsers(callerId, mateName);
    expect(out).not.toContain("没有找到"); // 防"未找到消息里回显姓名"的假阳性
    expect(out).toContain(mateName);
    expect(out).not.toContain("邮箱"); // 基础查询不含联系方式
  });

  it("does NOT find members of unrelated productions", async () => {
    const out = await queryUsers(callerId, outsiderName);
    expect(out).toContain("没有找到");
  });
});

describe("queryUserSensitive（联系方式）", () => {
  it("returns contact fields for a visible member", async () => {
    const out = await queryUserSensitive(callerId, mateName);
    expect(out).not.toContain("没有找到");
    expect(out).toContain(mateName);
    expect(out).toContain("邮箱");
    expect(out).toContain("电话");
  });

  it("refuses invisible targets the same as unknown ones", async () => {
    const out = await queryUserSensitive(callerId, outsiderName);
    expect(out).toContain("没有找到");
  });
});
