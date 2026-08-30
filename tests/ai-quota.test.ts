/**
 * AI 用量限流（#383，db/add-ai-quota.sql）：
 *   层 1 计价 —— usd/token → credit 折算，单价表是唯一来源
 *   层 2 聚合口径 —— 个人会话 + **当前** own 的项目都算 owner 头上；别人的项目不算
 *   层 3 两套账 —— extra / exempt 行不进窗口聚合
 *   层 4 判定与文案 —— 三种人三种说法；豁免不拦
 *   层 5 额外额度 —— 有余额就放行、FIFO 扣、最后一张可扣成负（允许的透支）
 *   层 6 兑换码 —— kind=ai_credits 只加额度不动档位
 *   层 7 可见性权限 —— 两枚 ai/* 键正交，没键 403、只有总览键拿不到成员分解
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser, deleteProduction } from "@/lib/db";
import {
  creditsFromUsd, creditsFromEmbeddingTokens, aiLimitsForTier, redeemPlanCode,
  CREDIT_USD, AI_UNIT_PRICES_USD_PER_M, USER_TIERS, FREE_TIER_AI,
} from "@/lib/plan";
import {
  getQuotaStatus, assertAiQuota, AiQuotaExceededError, paidFromOf,
  chargeExtraCredits, grantExtraCredits, extraRemaining,
  getProductionMemberUsage, quotaOwnerOf,
} from "@/lib/ai-quota";
import { makeProduction, cleanupProduction, setProductionTier, shortId } from "./factories";
import { GET as aiUsageGet } from "@/app/api/production/[id]/ai-usage/route";

const createdProds: string[] = [];
const createdUsers: string[] = [];
const createdCodes: string[] = [];

async function makeUser(tier?: "creator" | "internal"): Promise<{ userId: string; session: string }> {
  const { userId } = await upsertFeishuUser(`test-quota-${shortId()}`, `额度测试-${shortId()}`, null, false);
  createdUsers.push(userId);
  if (tier) {
    await getPool().query(
      "INSERT INTO user_plan (user_id, tier, source) VALUES ($1, $2, 'test') ON CONFLICT (user_id) DO UPDATE SET tier = $2",
      [userId, tier],
    );
  }
  return { userId, session: createSession({ userId, name: "额度测试", avatarUrl: null, isAdmin: false }) };
}

/** 直接往账本落一笔（绕开真模型调用；限流读的就是这张表）。 */
async function spend(args: {
  userId?: string | null; productionId?: string | null; credits: number;
  paidFrom?: "quota" | "extra" | "exempt"; ago?: string;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO ai_usage (user_id, production_id, kind, model, tokens, billed_credits, paid_from, created_at)
     VALUES ($1, $2, 'chat_input', 'test-model', 0, $3, $4, now() - $5::interval)`,
    [args.userId ?? null, args.productionId ?? null, args.credits, args.paidFrom ?? "quota", args.ago ?? "0 seconds"],
  );
}

/** 必须真的被拦住才返回错误——顺带断言了「没拦住」是失败而不是静默通过。 */
async function quotaError(args: { userId: string; productionId: string | null }): Promise<AiQuotaExceededError> {
  try {
    await assertAiQuota(args);
  } catch (e) {
    if (e instanceof AiQuotaExceededError) return e;
    throw e;
  }
  throw new Error("预期被额度门拦住，实际放行了");
}

async function makeProd(ownerId: string): Promise<string> {
  const { prodId } = await makeProduction(ownerId);
  createdProds.push(prodId);
  await setProductionTier(prodId, "pro");
  return prodId;
}

afterAll(async () => {
  for (const id of createdProds) await cleanupProduction(id).catch(() => {});
  for (const id of createdProds) await deleteProduction(id).catch(() => {});
  const pool = getPool();
  await pool.query("DELETE FROM ai_usage WHERE user_id = ANY($1)", [createdUsers]).catch(() => {});
  await pool.query("DELETE FROM ai_credit_grant WHERE user_id = ANY($1)", [createdUsers]).catch(() => {});
  await pool.query("DELETE FROM plan_code WHERE code = ANY($1)", [createdCodes]).catch(() => {});
});

// ── 层 1：计价 ───────────────────────────────────────────────────────────────

describe("credit 折算", () => {
  it("1 credit 就是 1 个 cache-miss input token 的钱", () => {
    expect(CREDIT_USD).toBeCloseTo(AI_UNIT_PRICES_USD_PER_M.chatInput / 1e6, 12);
    expect(creditsFromUsd(AI_UNIT_PRICES_USD_PER_M.chatInput)).toBe(1_000_000);
  });

  it("embedding 按自己的单价折价（比 chat 便宜一个量级）", () => {
    const c = creditsFromEmbeddingTokens(1_000_000);
    expect(c).toBe(creditsFromUsd(AI_UNIT_PRICES_USD_PER_M.embedding));
    expect(c).toBeLessThan(1_000_000 / 5);
  });

  it("非法输入归零，不产生 NaN 落库", () => {
    expect(creditsFromUsd(Number.NaN)).toBe(0);
    expect(creditsFromUsd(-1)).toBe(0);
    expect(creditsFromEmbeddingTokens(0)).toBe(0);
  });

  it("档位额度：free < creator < internal(无限)", () => {
    expect(aiLimitsForTier(null).daily).toBe(FREE_TIER_AI.aiDailyCredits);
    expect(aiLimitsForTier("creator").daily).toBeGreaterThan(aiLimitsForTier(null).daily);
    expect(aiLimitsForTier("internal").daily).toBe(Infinity);
    expect(aiLimitsForTier("internal").exempt).toBe(true);
    // 周闸是日闸的 4 倍而非 7 倍：允许集中爆发、禁止天天顶格
    expect(USER_TIERS.creator.aiWeeklyCredits).toBe(USER_TIERS.creator.aiDailyCredits * 4);
  });
});

// ── 层 2：聚合口径 ───────────────────────────────────────────────────────────

describe("用量聚合（主体是人）", () => {
  it("个人会话 + own 的项目都算 owner 头上；别人的项目不算", async () => {
    const me = await makeUser("creator");
    const other = await makeUser("creator");
    const mine = await makeProd(me.userId);
    const theirs = await makeProd(other.userId);

    await spend({ userId: me.userId, credits: 1000 });                            // 我的个人会话
    await spend({ userId: other.userId, productionId: mine, credits: 2000 });     // 别人在我的项目里用
    await spend({ userId: me.userId, productionId: theirs, credits: 4000 });      // 我在别人的项目里用

    const q = await getQuotaStatus({ userId: me.userId });
    expect(q.daily.used).toBe(3000);   // 1000 + 2000，不含我在别人项目里花的 4000

    const theirQ = await getQuotaStatus({ userId: other.userId });
    expect(theirQ.daily.used).toBe(4000);
  });

  it("项目会话的额度归属是项目**当前** owner，不是发起人", async () => {
    const owner = await makeUser("creator");
    const member = await makeUser();
    const prod = await makeProd(owner.userId);
    expect(await quotaOwnerOf(member.userId, prod)).toBe(owner.userId);

    await spend({ userId: member.userId, productionId: prod, credits: 5000 });
    const q = await getQuotaStatus({ userId: member.userId, productionId: prod });
    expect(q.ownerId).toBe(owner.userId);
    expect(q.daily.used).toBe(5000);
    // 成员自己的个人额度不因此被扣
    expect((await getQuotaStatus({ userId: member.userId })).daily.used).toBe(0);
  });

  it("日闸只看今天，周闸看整周", async () => {
    const me = await makeUser("creator");
    await spend({ userId: me.userId, credits: 700, ago: "0 seconds" });
    await spend({ userId: me.userId, credits: 900, ago: "30 hours" });
    const q = await getQuotaStatus({ userId: me.userId });
    expect(q.daily.used).toBe(700);
    // 30 小时前可能落在上一个自然周（周一零点前后），那时它不该进本周账
    expect([700, 1600]).toContain(q.weekly.used);
    expect(q.weekly.used).toBeGreaterThanOrEqual(q.daily.used);
  });
});

// ── 层 3：两套账 ─────────────────────────────────────────────────────────────

describe("paid_from 分账", () => {
  it("extra / exempt 行不进窗口聚合", async () => {
    const me = await makeUser("creator");
    await spend({ userId: me.userId, credits: 100, paidFrom: "quota" });
    await spend({ userId: me.userId, credits: 9_999_999, paidFrom: "extra" });
    await spend({ userId: me.userId, credits: 9_999_999, paidFrom: "exempt" });
    const q = await getQuotaStatus({ userId: me.userId });
    expect(q.daily.used).toBe(100);
  });
});

// ── 层 4：判定与文案 ─────────────────────────────────────────────────────────

describe("额度门", () => {
  it("窗口有余额 → 放行，支付源是 quota", async () => {
    const me = await makeUser("creator");
    const { paidFrom } = await assertAiQuota({ userId: me.userId, productionId: null });
    expect(paidFrom).toBe("quota");
  });

  it("个人会话用尽 → 429，文案说什么时候恢复、可兑换额度码", async () => {
    const me = await makeUser();  // free 档
    await spend({ userId: me.userId, credits: FREE_TIER_AI.aiDailyCredits });
    await expect(assertAiQuota({ userId: me.userId, productionId: null })).rejects.toThrow(AiQuotaExceededError);
    const err = await quotaError({ userId: me.userId, productionId: null });
    expect(err.status).toBe(429);
    expect(err.message).toContain("恢复");
    expect(err.message).toContain("额度码");
  });

  it("项目成员撞墙 → 让他找 owner，且不告诉他具体数字", async () => {
    const owner = await makeUser("creator");
    const member = await makeUser("creator");
    const prod = await makeProd(owner.userId);
    await spend({ userId: owner.userId, productionId: prod, credits: USER_TIERS.creator.aiDailyCredits });

    const err = await quotaError({ userId: member.userId, productionId: prod });
    expect(err.message).toContain("联系项目所有者");
    expect(err.message).not.toContain(String(USER_TIERS.creator.aiDailyCredits));
  });

  it("owner 自己撞墙 → 给数字和兑换指引", async () => {
    const owner = await makeUser("creator");
    const prod = await makeProd(owner.userId);
    await spend({ userId: owner.userId, productionId: prod, credits: USER_TIERS.creator.aiDailyCredits });
    const err = await quotaError({ userId: owner.userId, productionId: prod });
    expect(err.message).toContain("额度码");
    expect(err.message).not.toContain("联系项目所有者");
  });

  it("internal owner 豁免：花多少都不拦，支付源是 exempt", async () => {
    const owner = await makeUser("internal");
    const prod = await makeProd(owner.userId);
    await spend({ userId: owner.userId, productionId: prod, credits: 999_999_999, paidFrom: "exempt" });
    const { status, paidFrom } = await assertAiQuota({ userId: owner.userId, productionId: prod });
    expect(status.exempt).toBe(true);
    expect(paidFrom).toBe("exempt");
  });

  it("项目级豁免（特邀项目）同样不拦——两个来源正交", async () => {
    const owner = await makeUser("creator");
    const prod = await makeProd(owner.userId);
    await getPool().query("UPDATE production_plan SET billing_exempt = true WHERE production_id = $1", [prod]);
    await spend({ userId: owner.userId, productionId: prod, credits: USER_TIERS.creator.aiWeeklyCredits });
    const q = await getQuotaStatus({ userId: owner.userId, productionId: prod });
    expect(q.exempt).toBe(true);
    expect(q.allowed).toBe(true);
    // 但个人会话不沾这个项目的光：那是项目级豁免，不是人的
    expect((await getQuotaStatus({ userId: owner.userId })).exempt).toBe(false);
  });

  it("周闸先于日闸命中时报的是周", async () => {
    const me = await makeUser("creator");
    await spend({ userId: me.userId, credits: USER_TIERS.creator.aiWeeklyCredits });
    const q = await getQuotaStatus({ userId: me.userId });
    expect(q.blockedBy).toBe("weekly");
  });
});

// ── 层 5：额外额度 ───────────────────────────────────────────────────────────

describe("额外额度", () => {
  it("窗口满但有额外额度 → 放行，支付源切到 extra", async () => {
    const me = await makeUser();
    await spend({ userId: me.userId, credits: FREE_TIER_AI.aiWeeklyCredits });
    await grantExtraCredits({ userId: me.userId, credits: 50_000 });
    const { status, paidFrom } = await assertAiQuota({ userId: me.userId, productionId: null });
    expect(status.allowed).toBe(true);
    expect(paidFrom).toBe("extra");
  });

  it("FIFO：先扣快过期的那张", async () => {
    const me = await makeUser();
    const soon = new Date(Date.now() + 86_400_000);
    await grantExtraCredits({ userId: me.userId, credits: 1000, expiresAt: soon, note: "soon" });
    await grantExtraCredits({ userId: me.userId, credits: 1000, note: "never" });
    await chargeExtraCredits(me.userId, 600);
    const { rows } = await getPool().query<{ note: string; remaining: string }>(
      "SELECT note, remaining::text FROM ai_credit_grant WHERE user_id = $1 ORDER BY expires_at NULLS LAST",
      [me.userId],
    );
    expect(rows[0].note).toBe("soon");
    expect(Number(rows[0].remaining)).toBe(400);
    expect(Number(rows[1].remaining)).toBe(1000);
  });

  it("最后一张可以扣成负——这就是允许的那点透支", async () => {
    const me = await makeUser();
    await grantExtraCredits({ userId: me.userId, credits: 1000 });
    await chargeExtraCredits(me.userId, 3000);
    expect(await extraRemaining(me.userId)).toBe(-2000);
    // 透支后额度门关上（余额 <= 0）
    await spend({ userId: me.userId, credits: FREE_TIER_AI.aiWeeklyCredits });
    await expect(assertAiQuota({ userId: me.userId, productionId: null })).rejects.toThrow(AiQuotaExceededError);
  });

  it("过期的额度不算余额", async () => {
    const me = await makeUser();
    await grantExtraCredits({ userId: me.userId, credits: 5000, expiresAt: new Date(Date.now() - 1000) });
    expect(await extraRemaining(me.userId)).toBe(0);
  });

  it("paidFromOf：窗口还有一点就走 quota，一点不剩才走 extra", async () => {
    const me = await makeUser();
    await grantExtraCredits({ userId: me.userId, credits: 10_000 });
    await spend({ userId: me.userId, credits: FREE_TIER_AI.aiDailyCredits - 1 });
    expect(paidFromOf(await getQuotaStatus({ userId: me.userId }))).toBe("quota");
    await spend({ userId: me.userId, credits: 1 });
    expect(paidFromOf(await getQuotaStatus({ userId: me.userId }))).toBe("extra");
  });
});

// ── 层 6：兑换码 ─────────────────────────────────────────────────────────────

describe("AI 额度码", () => {
  it("kind=ai_credits 只加额度、不动档位", async () => {
    const me = await makeUser();
    const code = `TESTCRED-${shortId()}`;
    createdCodes.push(code);
    await getPool().query(
      `INSERT INTO plan_code (code, kind, grants_tier, grants_credits, max_uses) VALUES ($1, 'ai_credits', NULL, $2, 1)`,
      [code, 250_000],
    );
    const r = await redeemPlanCode({ code, userId: me.userId });
    expect(r.ok && r.kind === "credits" && r.credits).toBe(250_000);
    expect(await extraRemaining(me.userId)).toBe(250_000);
    const plan = await getPool().query("SELECT 1 FROM user_plan WHERE user_id = $1", [me.userId]);
    expect(plan.rows.length).toBe(0);
  });

  it("额度码不能兑到项目上（wrong_kind）", async () => {
    const me = await makeUser("creator");
    const prod = await makeProd(me.userId);
    const code = `TESTCRED-${shortId()}`;
    createdCodes.push(code);
    await getPool().query(
      `INSERT INTO plan_code (code, kind, grants_tier, grants_credits, max_uses) VALUES ($1, 'ai_credits', NULL, $2, 1)`,
      [code, 1000],
    );
    const r = await redeemPlanCode({ code, userId: me.userId, productionId: prod });
    expect(r).toEqual({ ok: false, reason: "wrong_kind" });
  });
});

// ── 层 7：可见性权限（ai/* 两枚键）───────────────────────────────────────────

function req(url: string, session?: string): NextRequest {
  const headers = new Headers();
  if (session) headers.set("cookie", `${SESSION_COOKIE}=${session}`);
  return new NextRequest(`http://localhost${url}`, { headers });
}

describe("用量可见性权限", () => {
  let owner: { userId: string; session: string };
  let member: { userId: string; session: string };
  let prod: string;

  beforeAll(async () => {
    owner = await makeUser("creator");
    member = await makeUser();
    prod = await makeProd(owner.userId);
    await getPool().query(
      `INSERT INTO production_member (production_id, user_id, status) VALUES ($1, $2, 'active')
       ON CONFLICT DO NOTHING`,
      [prod, member.userId],
    );
    await spend({ userId: member.userId, productionId: prod, credits: 3000 });
  });

  it("owner 旁路：不发键也看得到总览与成员分解", async () => {
    const res = await aiUsageGet(req(`/api/production/${prod}/ai-usage?members=1`, owner.session), { params: Promise.resolve({ id: prod }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.week).toBe(3000);
    expect(body.quota.extraRemaining).toBeDefined();     // 钱包只对 owner 显示
    expect(Array.isArray(body.members)).toBe(true);
  });

  it("普通成员没有 ai/* 键 → 403", async () => {
    const res = await aiUsageGet(req(`/api/production/${prod}/ai-usage`, member.session), { params: Promise.resolve({ id: prod }) });
    expect(res.status).toBe(403);
  });

  it("只发总览键 → 拿得到总量，拿不到成员分解、拿不到 owner 钱包", async () => {
    await getPool().query(
      `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES ($1, $2, 'ai', '*', 'usage', 'view', 'direct')`,
      [prod, member.userId],
    );
    const res = await aiUsageGet(req(`/api/production/${prod}/ai-usage?members=1`, member.session), { params: Promise.resolve({ id: prod }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.week).toBe(3000);
    expect(body.members).toBeUndefined();
    expect(body.quota.extraRemaining).toBeUndefined();
  });

  it("再发成员键 → 分解出现", async () => {
    await getPool().query(
      `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES ($1, $2, 'ai', '*', 'usage/members', 'view', 'direct')`,
      [prod, member.userId],
    );
    const res = await aiUsageGet(req(`/api/production/${prod}/ai-usage?members=1`, member.session), { params: Promise.resolve({ id: prod }) });
    const body = await res.json();
    expect(body.members).toHaveLength(1);
    expect(body.members[0].userId).toBe(member.userId);
    expect(body.members[0].week).toBe(3000);
  });

  it("成员分解按人分账，不按 owner 归并", async () => {
    const rows = await getProductionMemberUsage(prod);
    expect(rows.find((r) => r.userId === member.userId)?.week).toBe(3000);
    expect(rows.find((r) => r.userId === owner.userId)).toBeUndefined();
  });
});
