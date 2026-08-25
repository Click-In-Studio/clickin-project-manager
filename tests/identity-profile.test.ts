import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import {
  listProductionMembers,
  listProductionMembersWithRoles,
  listCueLists,
  bindPlatformIdentity,
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
  // searchUsersByName / listAllUsersWithContact 随 feishu-user-search 端点一并退役
  // （唯一调用方是 ContactsClient 里从未被渲染的 AddMemberPanel），其用例同批移除。

  it("findUserByName 按 user_profile 名匹配", async () => {
    const hit = await findUserByName(userName);
    expect(hit?.userId).toBe(userId);
  });
});

// updateUserContact（管理侧代填联系方式）已退役：注册与个人信息一律由本人填写，
// 管理侧只发码。它原来守的「不抢占他人身份」这条不变量，转由现存的唯一邮箱写入
// 路径 bindPlatformIdentity 承接——该函数此前没有任何测试覆盖。
describe("身份绑定不抢占他人", () => {
  it("email 已属他人时返回 conflict，且不改写身份归属", async () => {
    const other = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
    const otherId = other.rows[0].id;
    const email = `taken-${shortId()}@example.com`;
    await getPool().query(
      `INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_login_method, is_primary)
       VALUES ($1, 'email', $2, true, true)`,
      [otherId, email],
    );

    const res = await bindPlatformIdentity(userId, "email", email);
    expect(res.result).toBe("conflict");
    expect(res.result === "conflict" && res.existingUserId).toBe(otherId);

    const { rows } = await getPool().query<{ user_id: string }>(
      "SELECT user_id FROM user_platform_identity WHERE platform_id = 'email' AND platform_user_id = $1",
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(otherId);
    await getPool().query("DELETE FROM app_user WHERE id = $1", [otherId]);
  });

  it("同一账号重复绑定同一邮箱是幂等的 bound", async () => {
    const email = `rebind-${shortId()}@example.com`;
    expect((await bindPlatformIdentity(userId, "email", email)).result).toBe("bound");
    expect((await bindPlatformIdentity(userId, "email", email)).result).toBe("bound");
    const { rows } = await getPool().query(
      "SELECT 1 FROM user_platform_identity WHERE platform_id = 'email' AND platform_user_id = $1",
      [email],
    );
    expect(rows).toHaveLength(1);
  });
});
