import { describe, it, expect, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser, attachFeishuToUser } from "@/lib/db-feishu";
import { shortId } from "./factories";

// 飞书身份平权（db/add-feishu-identity-parity.sql）：飞书与邮箱是平权的登录通道，
// 飞书身份必须和邮箱一样登记进 user_platform_identity。
//
// 历史上只写 feishu_user 专用表，线上那批 identity 行是 PR #234 一次性回填的——
// 写入点不补齐的话，缺口会随每个新用户重新出现。这些用例守的就是这条规矩。
//
// 本批同时收口了替人建号的路径（import-contacts / sync-feishu-users /
// feishu-webhook 通讯录事件），upsertFeishuUser 因此成为飞书通道**唯一**的建号
// 入口——注册一律由本人走完，与邮箱通道的 upsertEmailUser 同级。
//
// 断言范围一律限定在本文件造的 open_id 上：其他测试（如 user-email.test.ts）会直接
// INSERT feishu_user 而不写 identity，全库不变量断言会被它们并发跑红。

const createdUserIds: string[] = [];

async function identityRows(openId: string) {
  const { rows } = await getPool().query<{
    user_id: string; is_login_method: boolean; is_primary: boolean;
  }>(
    `SELECT user_id, is_login_method, is_primary FROM user_platform_identity
     WHERE platform_id = 'feishu' AND platform_user_id = $1`,
    [openId],
  );
  return rows;
}

afterAll(async () => {
  // identity / feishu_user / user_profile 都是 ON DELETE CASCADE，删 app_user 即可
  await getPool()
    .query("DELETE FROM app_user WHERE id = ANY($1)", [createdUserIds])
    .catch(() => {});
});

describe("飞书身份平权", () => {
  it("upsertFeishuUser 建号时写入 feishu identity", async () => {
    const openId = `fip-${shortId()}`;
    const { userId } = await upsertFeishuUser(openId, "平权测试甲", null, false);
    createdUserIds.push(userId);

    const rows = await identityRows(openId);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(userId);
    expect(rows[0].is_login_method).toBe(true);
    expect(rows[0].is_primary).toBe(false);
  });

  it("存量账号缺 identity 时，再次登录自动补齐", async () => {
    // 造出历史状态：有 feishu_user 行，但没有 identity 行
    const openId = `fip-${shortId()}`;
    const { rows } = await getPool().query<{ id: string }>(
      "INSERT INTO app_user DEFAULT VALUES RETURNING id",
    );
    const userId = rows[0].id;
    createdUserIds.push(userId);
    await getPool().query(
      `INSERT INTO feishu_user (open_id, user_id, name, created_at, updated_at)
       VALUES ($1, $2, '历史遗留用户', NOW(), NOW())`,
      [openId, userId],
    );
    expect(await identityRows(openId)).toHaveLength(0);

    // 再次登录 —— 走的是 existing 分支，补齐必须发生在这条分支上而非只在建号分支
    await upsertFeishuUser(openId, "历史遗留用户", null, false);

    const after = await identityRows(openId);
    expect(after).toHaveLength(1);
    expect(after[0].user_id).toBe(userId);
  });

  it("重复登录幂等，不产生重复 identity 行", async () => {
    const openId = `fip-${shortId()}`;
    const { userId } = await upsertFeishuUser(openId, "幂等测试", null, false);
    createdUserIds.push(userId);

    await upsertFeishuUser(openId, "幂等测试改名", null, false);
    await upsertFeishuUser(openId, "幂等测试再改名", null, false);

    expect(await identityRows(openId)).toHaveLength(1);
  });

  it("同一 open_id 始终归到同一账号，不裂号", async () => {
    const openId = `fip-${shortId()}`;
    const a = await upsertFeishuUser(openId, "同一个人", null, false);
    const b = await upsertFeishuUser(openId, "同一个人", null, false);
    createdUserIds.push(a.userId);

    expect(b.userId).toBe(a.userId);
  });
});

// 绑定 ≠ 注册：账户页绑定飞书原先误用 upsertFeishuUser（注册入口），每绑一个新
// 飞书号就凭空造一个孤儿账号——feishu_user 指向孤儿、identity 指向本人，两边裂开。
describe("绑定飞书不建号", () => {
  async function bareUser(): Promise<string> {
    const { rows } = await getPool().query<{ id: string }>(
      "INSERT INTO app_user DEFAULT VALUES RETURNING id",
    );
    createdUserIds.push(rows[0].id);
    return rows[0].id;
  }

  it("新 open_id 挂到当前账号，feishu_user 与 identity 都指向它", async () => {
    const userId = await bareUser();
    const openId = `fip-bind-${shortId()}`;

    const res = await attachFeishuToUser(userId, openId, "绑定测试", null);
    expect(res.ok).toBe(true);

    // 关键：飞书行归属当前账号，而不是某个新建的账号
    const { rows } = await getPool().query<{ user_id: string }>(
      "SELECT user_id FROM feishu_user WHERE open_id = $1",
      [openId],
    );
    expect(rows[0].user_id).toBe(userId);

    const ident = await identityRows(openId);
    expect(ident).toHaveLength(1);
    expect(ident[0].user_id).toBe(userId);
  });

  it("open_id 已属他人 → openid_taken，不改归属", async () => {
    const owner = await bareUser();
    const other = await bareUser();
    const openId = `fip-bind-${shortId()}`;
    await attachFeishuToUser(owner, openId, "先到者", null);

    const res = await attachFeishuToUser(other, openId, "后到者", null);
    expect(res).toEqual({ ok: false, reason: "openid_taken" });

    const { rows } = await getPool().query<{ user_id: string }>(
      "SELECT user_id FROM feishu_user WHERE open_id = $1",
      [openId],
    );
    expect(rows[0].user_id).toBe(owner);
  });

  it("账号已绑其他飞书号 → user_has_other_feishu（feishu_user.user_id 唯一）", async () => {
    const userId = await bareUser();
    await attachFeishuToUser(userId, `fip-bind-${shortId()}`, "第一个", null);

    const res = await attachFeishuToUser(userId, `fip-bind-${shortId()}`, "第二个", null);
    expect(res).toEqual({ ok: false, reason: "user_has_other_feishu" });
  });

  it("重复绑定同一 open_id 到同一账号是幂等的", async () => {
    const userId = await bareUser();
    const openId = `fip-bind-${shortId()}`;
    expect((await attachFeishuToUser(userId, openId, "重复绑定", null)).ok).toBe(true);
    expect((await attachFeishuToUser(userId, openId, "重复绑定", null)).ok).toBe(true);
    expect(await identityRows(openId)).toHaveLength(1);
  });
});

describe("绑定并发安全", () => {
  // 注意：Promise.all 不保证真的制造出交错窗口（连接池可能把两次调用串行掉），
  // 所以这条用例是回归兜底而非并发语义的证明。真正的保证在 SQL 层——
  // attachFeishuToUser 的 ON CONFLICT ... WHERE user_id 相同才更新（见 db-feishu.ts）。
  it("两个账号同时抢同一 open_id：恰好一个成功，另一个 openid_taken", async () => {
    const openId = `fip-race-${shortId()}`;
    const a = (await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id")).rows[0].id;
    const b = (await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id")).rows[0].id;
    createdUserIds.push(a, b);

    const [ra, rb] = await Promise.all([
      attachFeishuToUser(a, openId, "抢注甲", null),
      attachFeishuToUser(b, openId, "抢注乙", null),
    ]);

    // 恰好一个成功——「都成功」意味着后到者拿到 ok 却没真正绑上
    const wins = [ra, rb].filter(r => r.ok).length;
    expect(wins).toBe(1);

    // 且 feishu_user 与 identity 必须指向同一个赢家
    const owner = (await getPool().query<{ user_id: string }>(
      "SELECT user_id FROM feishu_user WHERE open_id = $1", [openId],
    )).rows[0].user_id;
    const ident = await identityRows(openId);
    expect(ident).toHaveLength(1);
    expect(ident[0].user_id).toBe(owner);

    const winner = ra.ok ? a : b;
    expect(owner).toBe(winner);
  });
});
