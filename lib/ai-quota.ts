// AI 用量限流引擎（#383）。上限常量在 lib/plan.ts（库里只存档名的铁律），这里
// 只有聚合、判定与扣款。
//
// ─── 三条口径（改之前先读）──────────────────────────────────────────────────
//
// 1. **主体是人**。某人的用量 = 他的个人会话（production_id IS NULL）+ 他**当前**
//    own 的全部项目（谁在里面用都算他的）。owner 转移后账单随人走——聚合走
//    production.owner_id 实时 JOIN，任何地方不得物化「这个项目算谁的」。
//
// 2. **两套账互不污染**。窗口用量只 SUM paid_from='quota' 的行；额外额度是余额型，
//    自己在 ai_credit_grant.remaining 上减；豁免行记 'exempt' 两边都不进。于是
//    「本周用了多少」永远不会因为发过额度或豁免过而失真。
//
// 3. **判定一次，run 内不打断**。轮内超限打断＝把一次已经花掉的模型调用扔掉，
//    对用户是最差结局。代价是最后一次会扣穿（负 credit），透支上限由
//    RUN_CREDIT_HARD_CAP 封顶——那道闸防的是工具死循环，不是超支。

import { getPool } from "@/lib/pg";
import {
  aiLimitsForTier, getUserTier, getProductionPlan, newCreditGrantId, USER_TIERS,
  type UserTier,
} from "@/lib/plan";

export type QuotaWindow = { used: number; limit: number; resetAt: Date };

export type QuotaStatus = {
  /** 额度归属人（个人会话=本人，项目会话=项目当前 owner）。 */
  ownerId: string;
  tier: UserTier | null;
  tierLabel: string;
  /** 豁免（owner 是 internal ∨ 项目是特邀项目）→ 不限流，但照记。 */
  exempt: boolean;
  daily: QuotaWindow;
  weekly: QuotaWindow;
  /** 未过期额外额度的余额合计（可为负：透支未还）。 */
  extraRemaining: number;
  /** 还能不能发起下一轮。 */
  allowed: boolean;
  /** 用尽时命中的是哪个闸。 */
  blockedBy: "daily" | "weekly" | null;
};

/** 窗口口径：Asia/Shanghai 自然日 00:00 / 自然周一 00:00。 */
const TZ = "Asia/Shanghai";

async function windowBounds(): Promise<{ dayStart: Date; weekStart: Date; dayReset: Date; weekReset: Date }> {
  // 时区换算交给 PG：Node 侧手算 DST/周首日只会算错，而这条查询本来就要发。
  const { rows } = await getPool().query<{
    day_start: Date; week_start: Date; day_reset: Date; week_reset: Date;
  }>(
    `SELECT
       date_trunc('day',  now() AT TIME ZONE $1) AT TIME ZONE $1                       AS day_start,
       date_trunc('week', now() AT TIME ZONE $1) AT TIME ZONE $1                       AS week_start,
       (date_trunc('day',  now() AT TIME ZONE $1) + interval '1 day')  AT TIME ZONE $1 AS day_reset,
       (date_trunc('week', now() AT TIME ZONE $1) + interval '1 week') AT TIME ZONE $1 AS week_reset`,
    [TZ],
  );
  const r = rows[0];
  return { dayStart: r.day_start, weekStart: r.week_start, dayReset: r.day_reset, weekReset: r.week_reset };
}

/** 额度归属人：项目会话记项目**当前** owner，个人会话记本人。 */
export async function quotaOwnerOf(userId: string, productionId: string | null): Promise<string> {
  if (!productionId) return userId;
  const { rows } = await getPool().query<{ owner_id: string }>(
    "SELECT owner_id FROM production WHERE id = $1",
    [productionId],
  );
  return rows[0]?.owner_id ?? userId;
}

/** 窗口用量（credit）。个人会话按 user_id，项目按 owner_id 实时 JOIN。 */
async function windowUsage(ownerId: string, weekStart: Date, dayStart: Date): Promise<{ daily: number; weekly: number }> {
  const { rows } = await getPool().query<{ daily: string; weekly: string }>(
    `SELECT
       COALESCE(SUM(u.billed_credits) FILTER (WHERE u.created_at >= $3), 0)::text AS daily,
       COALESCE(SUM(u.billed_credits), 0)::text                                   AS weekly
     FROM ai_usage u
     LEFT JOIN production p ON p.id = u.production_id
     WHERE u.paid_from = 'quota'
       AND u.created_at >= $2
       AND ((u.production_id IS NULL AND u.user_id = $1) OR p.owner_id = $1)`,
    [ownerId, weekStart, dayStart],
  );
  return { daily: Number(rows[0]?.daily ?? 0), weekly: Number(rows[0]?.weekly ?? 0) };
}

/** 未过期额度余额合计（含已透支的负数）。 */
export async function extraRemaining(ownerId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT COALESCE(SUM(remaining), 0)::text AS n FROM ai_credit_grant
     WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
    [ownerId],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * 额度状态。productionId 传了就同时判项目级豁免（特邀项目）。
 * 归属人不传时按 (userId, productionId) 实时推导。
 */
export async function getQuotaStatus(args: {
  userId: string;
  productionId?: string | null;
}): Promise<QuotaStatus> {
  const productionId = args.productionId ?? null;
  const ownerId = await quotaOwnerOf(args.userId, productionId);
  const [tier, bounds, extra, projectExempt] = await Promise.all([
    getUserTier(ownerId),
    windowBounds(),
    extraRemaining(ownerId),
    productionId ? getProductionPlan(productionId).then((p) => p.billingExempt) : Promise.resolve(false),
  ]);
  const limits = aiLimitsForTier(tier);
  const exempt = limits.exempt || projectExempt;
  const { daily, weekly } = await windowUsage(ownerId, bounds.weekStart, bounds.dayStart);

  const dailyLeft = limits.daily - daily;
  const weeklyLeft = limits.weekly - weekly;
  // 两闸都满之后才动额外额度；只要还有余额就放行（透支的那点由硬顶封住）。
  const blockedBy = exempt ? null
    : weeklyLeft <= 0 && extra <= 0 ? "weekly"
    : dailyLeft <= 0 && extra <= 0 ? "daily"
    : null;

  return {
    ownerId,
    tier,
    tierLabel: tier ? USER_TIERS[tier].label : "普通用户",
    exempt,
    daily: { used: daily, limit: limits.daily, resetAt: bounds.dayReset },
    weekly: { used: weekly, limit: limits.weekly, resetAt: bounds.weekReset },
    extraRemaining: extra,
    allowed: blockedBy === null,
    blockedBy,
  };
}

/** 本次消耗该由谁买单——run 开始时定死，run 内不切换。 */
export type PaidFrom = "quota" | "extra" | "exempt";

export function paidFromOf(status: QuotaStatus): PaidFrom {
  if (status.exempt) return "exempt";
  const quotaLeft = Math.min(status.daily.limit - status.daily.used, status.weekly.limit - status.weekly.used);
  return quotaLeft > 0 ? "quota" : "extra";
}

export class AiQuotaExceededError extends Error {
  status = 429;
  constructor(message: string) {
    super(message);
    this.name = "AiQuotaExceededError";
  }
}

function resetPhrase(at: Date): string {
  const fmt = new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return fmt.format(at);
}

/**
 * run 开始处的门。过 → 返回本轮的支付源；不过 → 抛 AiQuotaExceededError。
 *
 * 文案分三种人，因为「该找谁」不一样：项目成员找 owner 补，owner 自己知道要买，
 * 个人会话等窗口恢复。**不向非 owner 暴露具体数字**——那是钱的信息，要看数字得
 * 有 node:ai/<prod>/usage@view。
 */
export async function assertAiQuota(args: {
  userId: string;
  productionId: string | null;
}): Promise<{ status: QuotaStatus; paidFrom: PaidFrom }> {
  const status = await getQuotaStatus(args);
  if (status.allowed) return { status, paidFrom: paidFromOf(status) };

  const win = status.blockedBy === "weekly" ? status.weekly : status.daily;
  const which = status.blockedBy === "weekly" ? "本周" : "今日";
  const reset = resetPhrase(win.resetAt);

  if (args.productionId && status.ownerId !== args.userId) {
    throw new AiQuotaExceededError(`本项目的 AI 额度已用尽，请联系项目所有者补充额度。（${which}额度将于 ${reset} 恢复）`);
  }
  const whose = args.productionId ? "本项目" : "你";
  throw new AiQuotaExceededError(
    `${whose}的 AI ${which}额度已用尽（${win.used.toLocaleString("zh-CN")} / ${win.limit.toLocaleString("zh-CN")}），将于 ${reset} 恢复。需要现在继续可兑换 AI 额度码补充。`,
  );
}

/**
 * 扣款：额度行落 ai_usage 由调用方写，这里只处理 extra 的余额减法。
 * 按 expires_at 最早的先扣（NULL 最后）；最后一张可以扣成负数——那就是允许的
 * 那点透支，下次充值先填坑。
 */
export async function chargeExtraCredits(ownerId: string, credits: number): Promise<void> {
  if (credits <= 0) return;
  const client = await getPool().connect();
  try {
    // 事务内 FOR UPDATE：并发两个 run 同时结算时不能重复吃掉同一张额度。
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; remaining: string }>(
      `SELECT id, remaining::text FROM ai_credit_grant
       WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())
       ORDER BY expires_at ASC NULLS LAST, created_at ASC
       FOR UPDATE`,
      [ownerId],
    );
    let left = credits;
    for (let i = 0; i < rows.length && left > 0; i++) {
      const isLast = i === rows.length - 1;
      const remaining = Number(rows[i].remaining);
      if (remaining <= 0 && !isLast) continue;
      // 最后一张吃掉全部余下的（可能扣成负）；其余按余额扣。
      const take = isLast ? left : Math.min(left, remaining);
      await client.query("UPDATE ai_credit_grant SET remaining = remaining - $2 WHERE id = $1", [rows[i].id, take]);
      left -= take;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── 可见性（#383 第 5 点：限流到点不能变成突然断服）─────────────────────────

export type ProductionUsage = {
  /** 本项目（不含 owner 的其他项目/个人会话）今日与本周消耗。 */
  today: number;
  week: number;
  /** owner 的额度全景——项目成员看到的「还剩多少」以此为准。 */
  quota: QuotaStatus;
};

export async function getProductionAiUsage(productionId: string, ownerId: string): Promise<ProductionUsage> {
  const bounds = await windowBounds();
  const [{ rows }, quota] = await Promise.all([
    getPool().query<{ today: string; week: string }>(
      `SELECT
         COALESCE(SUM(billed_credits) FILTER (WHERE created_at >= $2), 0)::text AS today,
         COALESCE(SUM(billed_credits), 0)::text                                 AS week
       FROM ai_usage WHERE production_id = $1 AND created_at >= $3`,
      [productionId, bounds.dayStart, bounds.weekStart],
    ),
    getQuotaStatus({ userId: ownerId, productionId }),
  ]);
  return { today: Number(rows[0]?.today ?? 0), week: Number(rows[0]?.week ?? 0), quota };
}

export type MemberUsage = { userId: string; name: string; today: number; week: number };

/** 本项目内按成员分解（node:ai/<prod>/usage/members@view）。 */
export async function getProductionMemberUsage(productionId: string): Promise<MemberUsage[]> {
  const bounds = await windowBounds();
  const { rows } = await getPool().query<{ user_id: string; name: string | null; today: string; week: string }>(
    `SELECT u.user_id,
            COALESCE(up.display_name, up.name) AS name,
            COALESCE(SUM(u.billed_credits) FILTER (WHERE u.created_at >= $2), 0)::text AS today,
            COALESCE(SUM(u.billed_credits), 0)::text                                   AS week
     FROM ai_usage u
     LEFT JOIN user_profile up ON up.user_id = u.user_id
     WHERE u.production_id = $1 AND u.created_at >= $3 AND u.user_id IS NOT NULL
     GROUP BY u.user_id, up.display_name, up.name
     ORDER BY SUM(u.billed_credits) DESC`,
    [productionId, bounds.dayStart, bounds.weekStart],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name ?? "（已退出成员）",
    today: Number(r.today),
    week: Number(r.week),
  }));
}

/** 管理员发放额外额度（无界面，脚本/手工 INSERT 的程序化入口）。 */
export async function grantExtraCredits(args: {
  userId: string; credits: number; note?: string | null; expiresAt?: Date | null; source?: string;
}): Promise<string> {
  const id = newCreditGrantId();
  await getPool().query(
    `INSERT INTO ai_credit_grant (id, user_id, credits, remaining, source, note, expires_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6)`,
    [id, args.userId, args.credits, args.source ?? "admin", args.note ?? null, args.expiresAt ?? null],
  );
  return id;
}
