import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { getWatermarkInfo, updateProductionMeta } from "@/lib/db";
import { makeProduction, cleanupProduction } from "./factories";

// 项目水印：开关读取 + 访问者身份解析
// （display_name 优先；email 走 user_platform_identity primary → feishu_user.email fallback）

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

let prodId: string;
let emailUser: string;   // user_profile + primary email identity（纯邮箱用户，无 feishu 行）
let feishuUser: string;  // 仅 feishu_user 行（email fallback 路径）

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  [emailUser, feishuUser] = await Promise.all([newUser(), newUser()]);
  await getPool().query(
    `INSERT INTO user_profile (user_id, name, display_name) VALUES ($1, '档案名', '显示名')`,
    [emailUser],
  );
  await getPool().query(
    `INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_primary)
     VALUES ($1, 'email', 'wm@example.com', true)`,
    [emailUser],
  );
  await getPool().query(
    `INSERT INTO feishu_user (open_id, user_id, name, email, created_at, updated_at)
     VALUES ('wm-feishu-1', $1, '飞书名', 'feishu-wm@example.com', NOW(), NOW())`,
    [feishuUser],
  );
});

afterAll(async () => {
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1)", [[emailUser, feishuUser]]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("getWatermarkInfo", () => {
  it("默认关闭", async () => {
    const info = await getWatermarkInfo(prodId, emailUser);
    expect(info.enabled).toBe(false);
  });

  it("开启后：display_name 优先 + primary email identity", async () => {
    await updateProductionMeta(prodId, { watermarkEnabled: true });
    const info = await getWatermarkInfo(prodId, emailUser);
    expect(info.enabled).toBe(true);
    expect(info.name).toBe("显示名");
    expect(info.email).toBe("wm@example.com");
  });

  it("无 email identity 时 fallback 到 feishu_user.email", async () => {
    const info = await getWatermarkInfo(prodId, feishuUser);
    expect(info.enabled).toBe(true);
    expect(info.name).toBe("飞书名");
    expect(info.email).toBe("feishu-wm@example.com");
  });

  it("关闭后 enabled=false（updateProductionMeta 往返）", async () => {
    await updateProductionMeta(prodId, { watermarkEnabled: false });
    const info = await getWatermarkInfo(prodId, emailUser);
    expect(info.enabled).toBe(false);
  });
});
