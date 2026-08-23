/**
 * 注册邀请制（db/add-registration-gate.sql + lib/registration-gate.ts）：
 *   · 开关关闭 → 一切照旧；开启 → 新邮箱需正当性四选一，老用户登录不受影响
 *   · 码在建号事务内锁行消耗 + 落流水；并发用尽整体回滚不产生账号
 *   · initiate 路由把 RegistrationDeniedError 映射为 403（文案面向用户）
 */
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  requireEmailRegistrationJustification,
  RegistrationDeniedError,
  registrationRateLimited,
} from "@/lib/registration-gate";
import { upsertEmailUser, upsertFeishuUser } from "@/lib/db";
import { createInvite } from "@/lib/invite-db";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { getPool } from "@/lib/pg";
import { POST as initiateHandler } from "@/app/api/auth/[platform]/initiate/route";

const cleanupEmails: string[] = [];
const cleanupCodes: string[] = [];
let cleanupProdId = "";

function freshEmail(): string {
  const e = `reg-test-${shortId()}@example.com`;
  cleanupEmails.push(e);
  return e;
}

async function makeRegCode(over: Partial<{ maxUses: number; usedCount: number; expiresAt: string | null }> = {}): Promise<string> {
  const code = `REG-${shortId()}`;
  cleanupCodes.push(code);
  await getPool().query(
    "INSERT INTO registration_code (code, max_uses, used_count, expires_at) VALUES ($1, $2, $3, $4)",
    [code, over.maxUses ?? 1, over.usedCount ?? 0, over.expiresAt ?? null],
  );
  return code;
}

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  const pool = getPool();
  // 依赖顺序：流水/身份行先于用户与码
  await pool.query(
    `DELETE FROM app_user WHERE id IN (
       SELECT user_id FROM user_platform_identity WHERE platform_id = 'email' AND platform_user_id = ANY($1)
     )`,
    [cleanupEmails],
  ).catch(() => {});
  await pool.query("DELETE FROM registration_code WHERE code = ANY($1)", [cleanupCodes]).catch(() => {});
  await pool.query("DELETE FROM registration_email WHERE email = ANY($1)", [cleanupEmails]).catch(() => {});
  if (cleanupProdId) await cleanupProduction(cleanupProdId).catch(() => {});
});

describe("正当性判定", () => {
  it("开关关闭 → null（不需要任何正当性）", async () => {
    vi.stubEnv("REGISTRATION_INVITE_ONLY", "");
    expect(await requireEmailRegistrationJustification({ email: freshEmail() })).toBeNull();
  });

  it("开启：新邮箱无任何正当性 → RegistrationDeniedError", async () => {
    vi.stubEnv("REGISTRATION_INVITE_ONLY", "1");
    await expect(requireEmailRegistrationJustification({ email: freshEmail() }))
      .rejects.toThrow(RegistrationDeniedError);
  });

  it("开启：老用户登录不受影响（existing）", async () => {
    vi.stubEnv("REGISTRATION_INVITE_ONLY", "");
    const email = freshEmail();
    await upsertEmailUser(email, "老用户");
    vi.stubEnv("REGISTRATION_INVITE_ONLY", "1");
    expect(await requireEmailRegistrationJustification({ email })).toEqual({ type: "existing" });
  });

  it("开启：registration_email 登记 → allowlist（大小写不敏感）", async () => {
    vi.stubEnv("REGISTRATION_INVITE_ONLY", "1");
    const email = freshEmail();
    await getPool().query("INSERT INTO registration_email (email, note) VALUES ($1, '测试登记')", [email]);
    expect(await requireEmailRegistrationJustification({ email: email.toUpperCase() }))
      .toEqual({ type: "allowlist" });
  });

  it("开启：定向项目邀请命中邮箱 → directed_invite；开放链接 token 透传 → invite_token", async () => {
    vi.stubEnv("REGISTRATION_INVITE_ONLY", "1");
    const owner = (await upsertFeishuUser(`test-open-${shortId()}`, `登记owner${shortId()}`, null, false)).userId;
    const { prodId } = await makeProduction(owner);
    cleanupProdId = prodId;

    const email = freshEmail();
    await createInvite({ productionId: prodId, createdBy: owner, email, expiresInDays: 7, maxUses: 1 });
    expect(await requireEmailRegistrationJustification({ email })).toEqual({ type: "directed_invite" });

    const { token } = await createInvite({ productionId: prodId, createdBy: owner, expiresInDays: null, maxUses: null });
    expect(await requireEmailRegistrationJustification({ email: freshEmail(), inviteToken: token }))
      .toEqual({ type: "invite_token" });

    // 已撤销的 token 不算正当性
    await getPool().query("UPDATE production_invite SET revoked_at = now() WHERE token = $1", [token]);
    await expect(requireEmailRegistrationJustification({ email: freshEmail(), inviteToken: token }))
      .rejects.toThrow(RegistrationDeniedError);
  });

  it("开启：注册码有效 → code；不存在/过期/用尽给对应文案", async () => {
    vi.stubEnv("REGISTRATION_INVITE_ONLY", "1");
    const code = await makeRegCode({ maxUses: 3 });
    expect(await requireEmailRegistrationJustification({ email: freshEmail(), registrationCode: code }))
      .toEqual({ type: "code", code });

    await expect(requireEmailRegistrationJustification({ email: freshEmail(), registrationCode: "REG-不存在" }))
      .rejects.toThrow("邀请码不存在");
    const expired = await makeRegCode({ expiresAt: "2020-01-01T00:00:00Z" });
    await expect(requireEmailRegistrationJustification({ email: freshEmail(), registrationCode: expired }))
      .rejects.toThrow("邀请码已过期");
    const used = await makeRegCode({ maxUses: 1, usedCount: 1 });
    await expect(requireEmailRegistrationJustification({ email: freshEmail(), registrationCode: used }))
      .rejects.toThrow("邀请码已被用完");
  });
});

describe("码在建号事务内消耗", () => {
  it("建号成功 → used_count+1 + 流水行；并发用尽 → 整体回滚不产生账号", async () => {
    const code = await makeRegCode({ maxUses: 1 });
    const email = freshEmail();
    const { userId } = await upsertEmailUser(email, "码注册用户", code);

    const c = await getPool().query<{ used_count: number }>(
      "SELECT used_count FROM registration_code WHERE code = $1", [code],
    );
    expect(c.rows[0].used_count).toBe(1);
    const log = await getPool().query<{ user_id: string; email: string }>(
      "SELECT user_id, email FROM registration_code_redemption WHERE code = $1", [code],
    );
    expect(log.rows[0]).toEqual({ user_id: userId, email });

    // 码已用尽：预检后被并发抢完的模拟——直接带用尽的码建号必须整体回滚
    const email2 = freshEmail();
    await expect(upsertEmailUser(email2, "抢码失败用户", code)).rejects.toThrow(RegistrationDeniedError);
    const orphan = await getPool().query(
      "SELECT 1 FROM user_platform_identity WHERE platform_id = 'email' AND platform_user_id = $1", [email2],
    );
    expect(orphan.rows.length).toBe(0);
  });

  it("真并发：两个请求同抢 max_uses=1 的码 → 恰好一个成功（FOR UPDATE 串行化）", async () => {
    const code = await makeRegCode({ maxUses: 1 });
    const emailA = freshEmail();
    const emailB = freshEmail();
    const results = await Promise.allSettled([
      upsertEmailUser(emailA, "并发甲", code),
      upsertEmailUser(emailB, "并发乙", code),
    ]);
    const ok = results.filter(r => r.status === "fulfilled");
    const failed = results.filter(r => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(RegistrationDeniedError);
    const c = await getPool().query<{ used_count: number }>(
      "SELECT used_count FROM registration_code WHERE code = $1", [code],
    );
    expect(c.rows[0].used_count).toBe(1);
    // 输家整体回滚：只有赢家的身份行存在
    const ids = await getPool().query(
      "SELECT platform_user_id FROM user_platform_identity WHERE platform_id = 'email' AND platform_user_id = ANY($1)",
      [[emailA, emailB]],
    );
    expect(ids.rows.length).toBe(1);
  });

  it("大小写变体不裂出重复账号（upsertEmailUser 入口归一）", async () => {
    const email = freshEmail();
    const { userId: a } = await upsertEmailUser(email, "小写注册");
    const { userId: b } = await upsertEmailUser(email.toUpperCase(), "大写再来");
    expect(b).toBe(a);
  });

  it("老用户路径不触码（不消耗）", async () => {
    const email = freshEmail();
    await upsertEmailUser(email, "先注册");
    const code = await makeRegCode({ maxUses: 1 });
    await upsertEmailUser(email, "再登录", code);
    const c = await getPool().query<{ used_count: number }>(
      "SELECT used_count FROM registration_code WHERE code = $1", [code],
    );
    expect(c.rows[0].used_count).toBe(0);
  });
});

describe("initiate 路由", () => {
  it("开启：新邮箱无正当性 → 403，服务端文案透出", async () => {
    vi.stubEnv("REGISTRATION_INVITE_ONLY", "1");
    const res = await initiateHandler(
      new NextRequest("http://localhost/api/auth/email/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: freshEmail(), name: "路人" }),
      }),
      { params: Promise.resolve({ platform: "email" }) },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("邀请");
  });

  it("按 IP 滑窗限流 → 429", async () => {
    vi.stubEnv("REGISTRATION_INVITE_ONLY", "1");
    const ip = `test-ip-${shortId()}`;
    for (let i = 0; i < 15; i++) expect(registrationRateLimited(ip)).toBe(false);
    expect(registrationRateLimited(ip)).toBe(true);
  });
});
