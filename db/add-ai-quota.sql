-- AI 用量限流（#383，等级体系 #280 的第二段）
--
-- 语义总纲：
--   · 限流主体是**人**，不是项目：某人的用量 = 他的个人会话 + 他**当前** own 的
--     全部项目的用量（谁在那些项目里用都算他的）。owner 转移后账单随人走——
--     聚合走 production.owner_id 实时 JOIN，任何地方不得物化「此项目算谁的」。
--   · 额度只挂 user_plan 档位（lib/plan.ts 常量）：free（无行）/ creator 有日周
--     双闸，internal 无限。production_plan 不加额度字段，它继续只管布尔 ai
--     （能不能用），用多少一律记 owner 头上。
--   · 计量单位 credit：1 credit = 1 个 deepseek-v4-flash cache-miss input token
--     的 peak 单价（$0.44/1M）。裸 token 会被 cache_read 淹没（缓存读只有 1/31
--     单价），按裸 token 限流会限错地方；credit 是成本折算，跨模型自动可比。
--     chat 侧的美元数由 provider 层算好（Model.cost，见 lib/agent-runtime/config.ts），
--     embedding 侧按常量折算——权重表不存在，只有单价表。
--   · 豁免（owner 是 internal ∨ production_plan.billing_exempt）= 不限流，但
--     照记（add-plan.sql 的既有约定），落 paid_from='exempt' 排除在窗口聚合外。

BEGIN;

-- ── ai_usage 记账两列 ────────────────────────────────────────────────────────
-- billed_credits：这一行的成本折算。BIGINT 而非 INTEGER——单位比 token 细，
-- 一次 compaction 就可能六位数。
-- paid_from：这一行由谁买的单。窗口聚合只 SUM 'quota' 行，于是窗口用量永远
-- 不会被 extra/豁免污染，两套账互不干扰。
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS billed_credits BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS paid_from      TEXT   NOT NULL DEFAULT 'quota';

ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_paid_from_check;
ALTER TABLE ai_usage ADD  CONSTRAINT ai_usage_paid_from_check
  CHECK (paid_from IN ('quota', 'extra', 'exempt'));

-- 存量行回填：按各 kind 的单价比折算（比值须与 lib/plan.ts 的单价表一致；
-- 改单价不回改历史行——历史按当时价计价是对的）。
--   chat_input      $0.44/1M → 1
--   chat_cache_read $0.014/1M → 0.0318
--   chat_output     $1.32/1M → 3
--   embedding_*     $0.07/1M → 0.1591（DashScope text-embedding-v4，¥0.0005/千）
UPDATE ai_usage SET billed_credits = round(tokens * CASE kind
    WHEN 'chat_input'      THEN 1.0
    WHEN 'chat_cache_read' THEN 0.0318
    WHEN 'chat_output'     THEN 3.0
    ELSE 0.1591
  END)
WHERE billed_credits = 0;

-- 窗口聚合的两条路径（个人会话按 user_id、项目按 production_id）各一条索引。
CREATE INDEX IF NOT EXISTS ai_usage_user_created_idx       ON ai_usage (user_id, created_at);
CREATE INDEX IF NOT EXISTS ai_usage_production_created_idx ON ai_usage (production_id, created_at);

-- ── 额外额度（管理员发放 / 兑换码）───────────────────────────────────────────
-- 余额型，不随窗口重置。窗口两闸都满之后才动它，按 expires_at 最早的先扣。
-- remaining 允许为负：判定在 run 开始处做一次，run 内不打断（轮内超限打断
-- 用户等于把一次已经花掉的调用扔掉），所以最后一次扣款可能扣穿——透支上限
-- 就是单个 run 的量，由 lib/plan.ts 的 RUN_CREDIT_HARD_CAP 封顶。
CREATE TABLE IF NOT EXISTS ai_credit_grant (
  id         TEXT        PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  credits    BIGINT      NOT NULL CHECK (credits > 0),
  remaining  BIGINT      NOT NULL,
  source     TEXT        NULL,   -- 'admin' | 'code:<code>'
  note       TEXT        NULL,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_credit_grant_user_idx ON ai_credit_grant (user_id, expires_at);

-- ── 兑换码扩展：kind='ai_credits' ────────────────────────────────────────────
-- 「想多用就买」的载体复用 plan_code：max_uses / expires_at / 兑换流水 /
-- 暴破限流全是现成的。credits 码不授档位，故 grants_tier 放开 NOT NULL。
ALTER TABLE plan_code DROP CONSTRAINT IF EXISTS plan_code_kind_check;
ALTER TABLE plan_code ADD  CONSTRAINT plan_code_kind_check
  CHECK (kind IN ('user_upgrade', 'production_upgrade', 'ai_credits'));
ALTER TABLE plan_code ALTER COLUMN grants_tier DROP NOT NULL;
ALTER TABLE plan_code ADD COLUMN IF NOT EXISTS grants_credits BIGINT NOT NULL DEFAULT 0;
ALTER TABLE plan_code DROP CONSTRAINT IF EXISTS plan_code_grants_check;
ALTER TABLE plan_code ADD  CONSTRAINT plan_code_grants_check
  CHECK ((kind = 'ai_credits') = (grants_tier IS NULL));

-- ── 权限键新类型 ai/*（用量可见性）───────────────────────────────────────────
-- 新 resource_type 必须先注册合法动词行（schema.sql resource_permission_level 规约），
-- 否则权限中心的键选择器里根本选不到它。
--   node:ai/<prod>/usage@view          项目 AI 用量总览（花了多少、还剩多少）
--   node:ai/<prod>/usage/members@view  按成员分解（谁花的）
-- 两枚都不是 SENSITIVE：它不是密钥也不是人事裁决，是「这个项目花了多少」。
-- 刻意不进任何角色模版：额度是 owner 的钱，默认只有 owner（第 1 步旁路）看得到，
-- 要给制作人看由 owner 在权限中心显式发。
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('ai', 'view', 0)
ON CONFLICT DO NOTHING;

COMMIT;
