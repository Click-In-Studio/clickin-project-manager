import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { getUserPrimaryEmail } from "@/lib/db";

// 打印水印身份来源：email identity 任一（primary 优先）→ feishu_user.email fallback

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

let primaryUser: string;   // primary + 非 primary 两条 email identity
let anyEmailUser: string;  // 仅非 primary email identity
let feishuUser: string;    // 仅 feishu_user.email
let bareUser: string;      // 什么都没有

beforeAll(async () => {
  [primaryUser, anyEmailUser, feishuUser, bareUser] = await Promise.all([
    newUser(), newUser(), newUser(), newUser(),
  ]);
  await getPool().query(
    `INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_primary) VALUES
       ($1, 'email', 'secondary@example.com', false),
       ($1, 'email', 'primary@example.com',   true),
       ($2, 'email', 'only-any@example.com',  false)`,
    [primaryUser, anyEmailUser],
  );
  await getPool().query(
    `INSERT INTO feishu_user (open_id, user_id, name, email, created_at, updated_at)
     VALUES ('ue-feishu-1', $1, '飞书邮箱用户', 'fs@example.com', NOW(), NOW())`,
    [feishuUser],
  );
});

afterAll(async () => {
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1)",
    [[primaryUser, anyEmailUser, feishuUser, bareUser]]).catch(() => {});
});

describe("getUserPrimaryEmail", () => {
  it("primary 优先", async () => {
    expect(await getUserPrimaryEmail(primaryUser)).toBe("primary@example.com");
  });

  it("无 primary 时取任一 email identity（宁可有）", async () => {
    expect(await getUserPrimaryEmail(anyEmailUser)).toBe("only-any@example.com");
  });

  it("无 email identity 时 fallback 到 feishu_user.email", async () => {
    expect(await getUserPrimaryEmail(feishuUser)).toBe("fs@example.com");
  });

  it("两处都无 → null", async () => {
    expect(await getUserPrimaryEmail(bareUser)).toBeNull();
  });
});
