import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import {
  listProductionMembers,
  listProductionMembersWithRoles,
  listCueLists,
  searchUsersByName,
  updateUserContact,
  findUserByName,
} from "@/lib/db";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// feishu_user 滥用债务清理：显示名/联系方式一律走 user_profile / identity 层。
// 核心回归：纯邮箱用户（app_user + user_profile，无 feishu_user 行）在成员列表、
// cue 表 creator、用户目录搜索中不得丢行；updateUserContact 写档案层可被读回。

let prodId: string;
let userId: string;
let userName: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  userName = `纯邮箱用户${shortId()}`;
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  userId = res.rows[0].id;
  await getPool().query(
    "INSERT INTO user_profile (user_id, name) VALUES ($1, $2)",
    [userId, userName],
  );
  await getPool().query(
    "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')",
    [prodId, userId],
  );
});

afterAll(async () => {
  await getPool().query("DELETE FROM app_user WHERE id = $1", [userId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("成员列表：无 feishu_user 行不丢行", () => {
  it("listProductionMembers 含纯邮箱用户，名字来自 user_profile", async () => {
    const members = await listProductionMembers(prodId);
    const me = members.find(m => m.userId === userId);
    expect(me).toBeDefined();
    expect(me!.name).toBe(userName);
    expect(me!.isAdmin).toBe(false);
  });

  it("listProductionMembersWithRoles 含纯邮箱用户", async () => {
    const members = await listProductionMembersWithRoles(prodId);
    const me = members.find(m => m.userId === userId);
    expect(me).toBeDefined();
    expect(me!.name).toBe(userName);
  });
});

describe("cue 表 creator 显示名", () => {
  it("纯邮箱用户创建的 cue 表不丢行且 created_by_name 正确", async () => {
    const clId = `cl${shortId()}`;
    await getPool().query(
      "INSERT INTO cue_list (id, production_id, name, created_by) VALUES ($1, $2, 'Q表', $3)",
      [clId, prodId, userId],
    );
    const lists = await listCueLists(prodId);
    const mine = lists.find(l => l.id === clId);
    expect(mine).toBeDefined();
    expect(mine!.createdByName).toBe(userName);
  });
});

describe("用户目录与名字匹配", () => {
  it("searchUsersByName 能搜到纯邮箱用户", async () => {
    const hits = await searchUsersByName(userName);
    expect(hits.map(h => h.userId)).toContain(userId);
  });

  it("findUserByName 按 user_profile 名匹配", async () => {
    const hit = await findUserByName(userName);
    expect(hit?.userId).toBe(userId);
  });
});

describe("updateUserContact 写档案层", () => {
  it("phone 写 user_profile、email 写 identity，成员列表可读回", async () => {
    const email = `debt-${shortId()}@example.com`;
    await updateUserContact(userId, email, "13800001234");
    const members = await listProductionMembersWithRoles(prodId);
    const me = members.find(m => m.userId === userId)!;
    expect(me.phone).toBe("13800001234");
    expect(me.email).toBe(email);
  });

  it("再次更新 email：旧联系邮箱行退役，读回最新值", async () => {
    const email2 = `debt2-${shortId()}@example.com`;
    await updateUserContact(userId, email2, null);
    const members = await listProductionMembersWithRoles(prodId);
    const me = members.find(m => m.userId === userId)!;
    expect(me.email).toBe(email2);
    const { rows } = await getPool().query<{ platform_user_id: string }>(
      `SELECT platform_user_id FROM user_platform_identity
       WHERE user_id = $1 AND platform_id = 'email'`,
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].platform_user_id).toBe(email2);
  });

  it("email 已被他人占用时静默跳过，不抢占身份", async () => {
    const other = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
    const otherId = other.rows[0].id;
    const email = `taken-${shortId()}@example.com`;
    await getPool().query(
      `INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_login_method, is_primary)
       VALUES ($1, 'email', $2, true, true)`,
      [otherId, email],
    );
    await updateUserContact(userId, email, null);
    const { rows } = await getPool().query<{ user_id: string }>(
      "SELECT user_id FROM user_platform_identity WHERE platform_id = 'email' AND platform_user_id = $1",
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(otherId);
    await getPool().query("DELETE FROM app_user WHERE id = $1", [otherId]);
  });
});
