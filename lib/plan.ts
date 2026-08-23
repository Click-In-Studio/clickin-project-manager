import { getPool } from "@/lib/pg";
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
}> = {
  creator:  { label: "创作者",  maxOwnedProductions: 5,        initialProductionTier: "free", billingExempt: false },
  internal: { label: "内部成员", maxOwnedProductions: Infinity, initialProductionTier: "pro",  billingExempt: true },
};

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
 * 再进一人是否会超出档位人数上限。计入所有未退出成员（含 owner）。
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

export type RedeemResult =
  | { ok: true; tier: string; billingExempt: boolean }
  | { ok: false; reason: "not_found" | "wrong_kind" | "expired" | "exhausted" | "unknown_tier" | "no_effect" };

export async function redeemPlanCode(args: {
  code: string;
  userId: string;
  /** 传了 = 兑到项目（production_upgrade 码）；不传 = 兑到用户本人（user_upgrade 码）。 */
  productionId?: string;
}): Promise<RedeemResult> {
  const { code, userId, productionId } = args;
  const wantKind = productionId ? "production_upgrade" : "user_upgrade";
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      kind: string; grants_tier: string; grants_exempt: boolean; exempt_note: string | null;
      max_uses: number; used_count: number; expires_at: Date | null;
    }>(
      `SELECT kind, grants_tier, grants_exempt, exempt_note, max_uses, used_count, expires_at
       FROM plan_code WHERE code = $1 FOR UPDATE`,
      [code],
    );
    const c = rows[0];
    if (!c) { await client.query("ROLLBACK"); return { ok: false, reason: "not_found" }; }
    if (c.kind !== wantKind) { await client.query("ROLLBACK"); return { ok: false, reason: "wrong_kind" }; }
    if (c.expires_at && c.expires_at.getTime() < Date.now()) {
      await client.query("ROLLBACK"); return { ok: false, reason: "expired" };
    }
    if (c.used_count >= c.max_uses) { await client.query("ROLLBACK"); return { ok: false, reason: "exhausted" }; }

    let applied: RedeemResult;
    if (productionId) {
      if (!isProductionTier(c.grants_tier)) { await client.query("ROLLBACK"); return { ok: false, reason: "unknown_tier" }; }
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
      applied = { ok: true, tier: newTier, billingExempt: cur.billingExempt || c.grants_exempt };
    } else {
      if (!isUserTier(c.grants_tier)) { await client.query("ROLLBACK"); return { ok: false, reason: "unknown_tier" }; }
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
      applied = { ok: true, tier: c.grants_tier, billingExempt: false };
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
