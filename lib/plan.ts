import { getPool } from "@/lib/pg";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";

// ─── 等级体系（#280，db/add-plan.sql）───────────────────────────────────────────
// tier → limit 的映射只在这里：库里只存档名，改上限/加档位＝改代码＝走 PR。
//
// 消费面约定（改动前先读）：
//   · 用户等级全站只在「建项目」一处被消费（app/api/productions POST）。
//     功能跟项目走——人的等级不影响他在项目里能用什么。
//   · 项目功能门（requireProductionFeature）独立于 grant/policy 两层：它挡的是
//     「这个档位没开这个功能」，不否决任何已存在的 grant 行（policy-keys.ts 铁律）。
//   · 计费豁免两来源正交：owner 级（internal 档，按**当前** owner 实时推导，任何
//     地方不得缓存「此项目免费」）∨ 项目级（production_plan.billing_exempt，特邀
//     项目，落库记录）。豁免 ≠ 不记账：ai_usage 照记，只在出账层归零。

// ─── AI 用量计价与额度（#383）─────────────────────────────────────────────────
//
// **计量单位 credit**：1 credit = 1 个 deepseek-v4-flash cache-miss input token 的
// peak 单价（$0.44/1M）。为什么不是裸 token——一次 run 的 token 里 cache_read 占
// 七成，而它只有 1/31 的单价；按裸 token 限流会把额度花在最便宜的那部分上，
// 而 output（3 倍单价）几乎不计。credit 是成本折算，跨模型自动可比，换模型只改
// 单价不改档位数。
//
// **限流主体是人**：某人的用量 = 他的个人会话 + 他**当前** own 的全部项目
// （谁在那些项目里用都算他的）。额度只挂 user_plan 档位，PRODUCTION_TIERS 不加
// 额度字段——项目档继续只管布尔 ai（能不能用），用多少一律记 owner 头上。
// 团队人多不缩放额度：那是 owner 该买额度的信号，不是我们替他买单的理由。
//
// **单价来源**：DeepSeek 官方价目（peak 价；off-peak 半价，我们按 peak 记 = 保守，
// 实际账单只会更低）。chat 侧的美元数不在这里算——Model.cost 填了真单价后由
// provider 层逐条算好（lib/agent-runtime/config.ts），这里只负责 $ → credit。
// 改单价不回改历史行：历史按当时价计价是对的。

/** $/1M token。改这里 = 改所有档位的实际购买力，改动要连带复核档位数值。 */
export const AI_UNIT_PRICES_USD_PER_M = {
  /** credit 的定义锚点：flash cache-miss input。 */
  chatInput: 0.44,
  /** DashScope text-embedding-v4（¥0.0005/千 ≈ $0.07/1M）。 */
  embedding: 0.07,
} as const;

/** 1 credit 的美元价 = 锚点单价 / 1M。 */
export const CREDIT_USD = AI_UNIT_PRICES_USD_PER_M.chatInput / 1_000_000;

/** 美元 → credit（四舍五入到整数；负数与 NaN 归零）。 */
export function creditsFromUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd / CREDIT_USD);
}

/** embedding token → credit（provider 层不经手 embedding，单价在这里折算）。 */
export function creditsFromEmbeddingTokens(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return creditsFromUsd((tokens * AI_UNIT_PRICES_USD_PER_M.embedding) / 1_000_000);
}

/**
 * 档位额度（credit）。标定基准：线上实测一次问答 ≈ 12k credit ≈ $0.005
 * （input 4.6k + cache_read 16k + output 2.4k，2026-08-29 ai_usage 实测均值）。
 *   free    100k/日 ≈ 8 次、400k/周 ≈ 33 次   —— 只够个人会话轻用
 *   creator 3M/日 ≈ 250 次、12M/周 ≈ 975 次   —— 全队共享一个池子
 * 周额度 ≈ 日额度 × 4 而非 × 7 是刻意的：日闸管峰值、周闸管总量，允许集中爆发、
 * 禁止天天顶格。
 */
const AI_CREDITS = {
  freeDaily: 100_000,
  freeWeekly: 400_000,
  creatorDaily: 3_000_000,
  creatorWeekly: 12_000_000,
} as const;

/**
 * 单个 run 的硬顶（credit）——防失控，不是限流。
 *
 * 额度判定在 run 开始处做一次、run 内不打断（轮内打断等于把一次已经花掉的调用
 * 扔掉），所以透支上限 = 单个 run 能烧的量。没有这道闸，一个工具死循环就能把
 * 「少量负 credit」变成无底洞。200k ≈ 正常 run 的 16 倍、约 35 次模型调用。
 */
export const RUN_CREDIT_HARD_CAP = Number(process.env.AI_RUN_CREDIT_HARD_CAP ?? 200_000);

export type UserTier = "creator" | "internal";
export type ProductionTier = "free" | "pro";

/** 档位序（索引即高低），码兑换只升不降的比较基准。 */
export const USER_TIER_ORDER: readonly UserTier[] = ["creator", "internal"];
export const PRODUCTION_TIER_ORDER: readonly ProductionTier[] = ["free", "pro"];

export const USER_TIERS: Record<UserTier, {
  label: string;
  /** 可同时 own 的未归档项目数上限。 */
  maxOwnedProductions: number;
  /** 建项目时项目的初始档位（声明式例外：internal 建项即最高档）。 */
  initialProductionTier: ProductionTier;
  /** own 的项目计费豁免（内部成员）。计费时按当前 owner 查这里。 */
  billingExempt: boolean;
  /** AI 日/周额度（credit，见下方单价表）。billingExempt 档不判这两个数。 */
  aiDailyCredits: number;
  aiWeeklyCredits: number;
  /** 同时活跃的 AI 定时任务数上限（个人 + 他建在各制作里的，按创建者算）。 */
  maxActiveSchedules: number;
}> = {
  creator:  { label: "创作者",  maxOwnedProductions: 5,        initialProductionTier: "free", billingExempt: false,
              aiDailyCredits: AI_CREDITS.creatorDaily, aiWeeklyCredits: AI_CREDITS.creatorWeekly, maxActiveSchedules: 20 },
  internal: { label: "内部成员", maxOwnedProductions: Infinity, initialProductionTier: "pro",  billingExempt: true,
              aiDailyCredits: Infinity, aiWeeklyCredits: Infinity, maxActiveSchedules: Infinity },
};

/** 无 user_plan 行的普通注册用户（"free 档"）的额度。建不了项目，所以这份额度
 *  只会花在个人会话上——它堵的是「个人会话此前完全没有档位门」这个敞口。 */
export const FREE_TIER_AI = {
  label: "普通用户",
  aiDailyCredits: AI_CREDITS.freeDaily,
  aiWeeklyCredits: AI_CREDITS.freeWeekly,
  maxActiveSchedules: 3,
} as const;

/**
 * AI 定时任务的成本闸（与额度正交：额度管总量，这里管"一条任务能多勤"）。
 * 项目会话的额度记 owner 头上，一个成员建 `*\/5 * * * *` 就是在烧 owner 的钱——
 * 所以最小间隔与每日触发上限是平台常量，不随档位放宽。
 */
export const SCHEDULE_LIMITS = {
  /** every 类任务的最小间隔 */
  minIntervalMs: 60 * 60_000,
  /** cron 表达式按未来 7 天采样，日均触发次数上限 */
  maxFiresPerDay: 24,
  /** 一次性任务最远只能定到多久之后 */
  maxAtHorizonMs: 366 * 24 * 60 * 60_000,
} as const;

/** 档位的定时任务数上限（tier 为 null = 无 user_plan 行）。 */
export function maxActiveSchedulesForTier(tier: UserTier | null): number {
  return tier ? USER_TIERS[tier].maxActiveSchedules : FREE_TIER_AI.maxActiveSchedules;
}

/** 档位的 AI 额度（tier 为 null = 无 user_plan 行）。 */
export function aiLimitsForTier(tier: UserTier | null): { daily: number; weekly: number; exempt: boolean } {
  if (!tier) return { daily: FREE_TIER_AI.aiDailyCredits, weekly: FREE_TIER_AI.aiWeeklyCredits, exempt: false };
  const t = USER_TIERS[tier];
  return { daily: t.aiDailyCredits, weekly: t.aiWeeklyCredits, exempt: t.billingExempt };
}

export type ProductionFeature = "ai" | "advancedPerms";

export const PRODUCTION_TIERS: Record<ProductionTier, {
  label: string;
  /** 成员人数上限（含 owner），在 acceptInvite/claimInvite 事务内判。 */
  seatLimit: number;
  ai: boolean;
  advancedPerms: boolean;
}> = {
  free: { label: "免费档", seatLimit: 10,  ai: false, advancedPerms: false },
  pro:  { label: "专业档", seatLimit: 200, ai: true,  advancedPerms: true },
};

const FEATURE_LABELS: Record<ProductionFeature, string> = {
  ai: "AI 助手",
  advancedPerms: "高级权限配置",
};

function isUserTier(t: string): t is UserTier { return t in USER_TIERS; }
function isProductionTier(t: string): t is ProductionTier { return t in PRODUCTION_TIERS; }

/**
 * 库里的原始档名 → 档位。无行 / 未知档名都归 free，与 getProductionPlan 同语义。
 * 给已经在别处 JOIN 出 production_plan.tier 的查询用（如 listMyProductionsWithRoles），
 * 免得为了菜单显隐再逐项目查一次库。
 */
export function normalizeProductionTier(raw: string | null | undefined): ProductionTier {
  return raw && isProductionTier(raw) ? raw : "free";
}

// ─── 读取 ─────────────────────────────────────────────────────────────────────

/** 无行 = null（普通用户）。库里出现未知档名视同无行（常量表回滚过的防御）。 */
export async function getUserTier(userId: string): Promise<UserTier | null> {
  const { rows } = await getPool().query<{ tier: string }>(
    "SELECT tier FROM user_plan WHERE user_id = $1",
    [userId],
  );
  const t = rows[0]?.tier;
  return t && isUserTier(t) ? t : null;
}

export type ProductionPlanInfo = { tier: ProductionTier; billingExempt: boolean; exemptNote: string | null };

/** 无行 = free。可传事务 client（座位判定要在 invite 事务内读）。 */
export async function getProductionPlan(
  productionId: string,
  client?: PoolClient,
): Promise<ProductionPlanInfo> {
  const q = client ?? getPool();
  const { rows } = await q.query<{ tier: string; billing_exempt: boolean; exempt_note: string | null }>(
    "SELECT tier, billing_exempt, exempt_note FROM production_plan WHERE production_id = $1",
    [productionId],
  );
  const r = rows[0];
  const tier = r && isProductionTier(r.tier) ? r.tier : "free";
  return { tier, billingExempt: r?.billing_exempt ?? false, exemptNote: r?.exempt_note ?? null };
}

export async function countOwnedActiveProductions(userId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    "SELECT count(*) AS n FROM production WHERE owner_id = $1 AND archived_at IS NULL",
    [userId],
  );
  return Number(rows[0].n);
}

// ─── 项目功能门 ───────────────────────────────────────────────────────────────

export async function productionFeatureAllowed(
  productionId: string,
  feature: ProductionFeature,
): Promise<boolean> {
  const { tier } = await getProductionPlan(productionId);
  return PRODUCTION_TIERS[tier][feature];
}

/**
 * 档位功能门：过 → null，不过 → 403 Response。放在 requireGrantGate **之前**、
 * 独立于 grant 判定——它不否决权限行，只表达「档位没开这个功能」。
 */
export async function requireProductionFeature(
  productionId: string,
  feature: ProductionFeature,
): Promise<Response | null> {
  if (await productionFeatureAllowed(productionId, feature)) return null;
  return Response.json(
    { error: `当前项目档位未开通「${FEATURE_LABELS[feature]}」，请项目所有者兑换升级码后使用` },
    { status: 403 },
  );
}

/**
 * 座位判定（事务内用，与 invite 的 FOR UPDATE 同事务保证并发安全）：
 * 再进一人是否会超出档位人数上限。计入所有未离组成员（含 owner）。
 *
 * **suspended 占席位**（#141）。停用/自助退出的人授权还冻着、随时可原样复职，
 * 席位就是为这份可逆性预留的资源。不占的话会出现一个无解的冲突：满员时停用一人、
 * 补进新人，原来那人要复职就超编——而复职是「恢复原状」，拒绝他等于把踢人的决定
 * 强加给 owner。反过来，「停用不省钱」也堵死了淡季全员停用、旺季复职的套利。
 *
 * 释放席位的动作是「确认离组」：那才是终态，授权真撤，回来要走邀请（重新过本判定）。
 */
export async function seatsFullForNewMember(
  client: PoolClient,
  productionId: string,
): Promise<boolean> {
  const { tier } = await getProductionPlan(productionId, client);
  const limit = PRODUCTION_TIERS[tier].seatLimit;
  const { rows } = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM production_member WHERE production_id = $1 AND status <> 'exited'",
    [productionId],
  );
  return Number(rows[0].n) >= limit;
}

// ─── 兑换码 ───────────────────────────────────────────────────────────────────
// plan_code 无创建界面（管理员手工 INSERT）。兑换只升不降；码对现状无任何提升时
// 不消耗使用次数（no_effect）。

/** ai_credit_grant 的 short id（仓库 id 规约：新表 TEXT PK + 前缀 + 时间 + 随机尾）。 */
export function newCreditGrantId(): string {
  return `acg_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

export type RedeemResult =
  | { ok: true; kind: "tier"; tier: string; billingExempt: boolean }
  | { ok: true; kind: "credits"; credits: number }
  | { ok: false; reason: "not_found" | "wrong_kind" | "expired" | "exhausted" | "unknown_tier" | "no_effect" };

export async function redeemPlanCode(args: {
  code: string;
  userId: string;
  /** 传了 = 兑到项目（production_upgrade 码）；不传 = 兑到用户本人（user_upgrade / ai_credits 码）。 */
  productionId?: string;
}): Promise<RedeemResult> {
  const { code, userId, productionId } = args;
  // 个人侧两种码共用同一个入口：升档码与 AI 额度码（#383）。
  const wantKinds = productionId ? ["production_upgrade"] : ["user_upgrade", "ai_credits"];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      kind: string; grants_tier: string | null; grants_exempt: boolean; grants_credits: string;
      exempt_note: string | null; max_uses: number; used_count: number; expires_at: Date | null;
    }>(
      `SELECT kind, grants_tier, grants_exempt, grants_credits, exempt_note, max_uses, used_count, expires_at
       FROM plan_code WHERE code = $1 FOR UPDATE`,
      [code],
    );
    const c = rows[0];
    if (!c) { await client.query("ROLLBACK"); return { ok: false, reason: "not_found" }; }
    if (!wantKinds.includes(c.kind)) { await client.query("ROLLBACK"); return { ok: false, reason: "wrong_kind" }; }
    if (c.expires_at && c.expires_at.getTime() < Date.now()) {
      await client.query("ROLLBACK"); return { ok: false, reason: "expired" };
    }
    if (c.used_count >= c.max_uses) { await client.query("ROLLBACK"); return { ok: false, reason: "exhausted" }; }

    let applied: RedeemResult;
    if (c.kind === "ai_credits") {
      // 额度码：累加，没有「只升不降」一说，也就没有 no_effect。
      const credits = Number(c.grants_credits);
      if (!Number.isFinite(credits) || credits <= 0) {
        await client.query("ROLLBACK"); return { ok: false, reason: "unknown_tier" };
      }
      await client.query(
        `INSERT INTO ai_credit_grant (id, user_id, credits, remaining, source, note)
         VALUES ($1, $2, $3, $3, $4, $5)`,
        [newCreditGrantId(), userId, credits, `code:${code}`, c.exempt_note],
      );
      applied = { ok: true, kind: "credits", credits };
    } else if (productionId) {
      if (!c.grants_tier || !isProductionTier(c.grants_tier)) { await client.query("ROLLBACK"); return { ok: false, reason: "unknown_tier" }; }
      const cur = await getProductionPlan(productionId, client);
      const tierUp = PRODUCTION_TIER_ORDER.indexOf(c.grants_tier) > PRODUCTION_TIER_ORDER.indexOf(cur.tier);
      const exemptUp = c.grants_exempt && !cur.billingExempt;
      if (!tierUp && !exemptUp) { await client.query("ROLLBACK"); return { ok: false, reason: "no_effect" }; }
      const newTier = tierUp ? c.grants_tier : cur.tier;
      await client.query(
        `INSERT INTO production_plan (production_id, tier, billing_exempt, exempt_note, source)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (production_id) DO UPDATE SET
           tier = EXCLUDED.tier,
           billing_exempt = production_plan.billing_exempt OR EXCLUDED.billing_exempt,
           exempt_note = COALESCE(EXCLUDED.exempt_note, production_plan.exempt_note),
           source = EXCLUDED.source,
           updated_at = now()`,
        [productionId, newTier, cur.billingExempt || c.grants_exempt,
         exemptUp ? c.exempt_note : null, `code:${code}`],
      );
      applied = { ok: true, kind: "tier", tier: newTier, billingExempt: cur.billingExempt || c.grants_exempt };
    } else {
      if (!c.grants_tier || !isUserTier(c.grants_tier)) { await client.query("ROLLBACK"); return { ok: false, reason: "unknown_tier" }; }
      const { rows: cur } = await client.query<{ tier: string }>(
        "SELECT tier FROM user_plan WHERE user_id = $1 FOR UPDATE",
        [userId],
      );
      const curTier = cur[0]?.tier && isUserTier(cur[0].tier) ? cur[0].tier : null;
      const curRank = curTier ? USER_TIER_ORDER.indexOf(curTier) : -1;
      if (USER_TIER_ORDER.indexOf(c.grants_tier) <= curRank) {
        await client.query("ROLLBACK"); return { ok: false, reason: "no_effect" };
      }
      await client.query(
        `INSERT INTO user_plan (user_id, tier, source) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET tier = EXCLUDED.tier, source = EXCLUDED.source, updated_at = now()`,
        [userId, c.grants_tier, `code:${code}`],
      );
      applied = { ok: true, kind: "tier", tier: c.grants_tier, billingExempt: false };
    }

    await client.query("UPDATE plan_code SET used_count = used_count + 1 WHERE code = $1", [code]);
    await client.query(
      "INSERT INTO plan_code_redemption (code, user_id, production_id) VALUES ($1, $2, $3)",
      [code, userId, productionId ?? null],
    );
    await client.query("COMMIT");
    return applied;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── 兑换尝试限流（#307 review finding 2）───────────────────────────────────────
// 码是管理员手工生成的高价值凭证，裸端点是暴破面。按 userId 滑动窗口限次；
// module-level 状态是进程级的——与本仓 Idempotency 缓存同一个单进程部署假设。

const _redeemAttempts = new Map<string, { count: number; windowStart: number }>();
const REDEEM_WINDOW_MS = 10 * 60_000;
const REDEEM_MAX_ATTEMPTS = 10;

/** true = 已超限（调用方回 429）。每次调用计一次尝试，成功兑换也计——正常使用远够。 */
export function redeemRateLimited(userId: string): boolean {
  const now = Date.now();
  const entry = _redeemAttempts.get(userId);
  if (!entry || now - entry.windowStart > REDEEM_WINDOW_MS) {
    _redeemAttempts.set(userId, { count: 1, windowStart: now });
    // Evict stale entries opportunistically
    if (_redeemAttempts.size > 1000) {
      for (const [k, v] of _redeemAttempts) {
        if (now - v.windowStart > REDEEM_WINDOW_MS) _redeemAttempts.delete(k);
      }
    }
    return false;
  }
  entry.count++;
  return entry.count > REDEEM_MAX_ATTEMPTS;
}

export const REDEEM_ERROR_MESSAGES: Record<Extract<RedeemResult, { ok: false }>["reason"], string> = {
  not_found: "兑换码不存在",
  wrong_kind: "该兑换码不适用于此处（用户码与项目码不通用）",
  expired: "兑换码已过期",
  exhausted: "兑换码已被用完",
  unknown_tier: "兑换码档位无效，请联系管理员",
  no_effect: "当前档位已不低于该兑换码，无需兑换",
};
