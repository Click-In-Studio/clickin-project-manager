-- 等级体系（#280 用户等级 / 项目等级，付费功能地基）
--
-- 语义总纲：
--   · user_plan 无行 = 普通注册用户：能用被邀请进入的项目的一切功能，但不能建项目。
--     有行（creator/internal）才可建项目。用户等级全站只在「建项目」一处被消费——
--     功能跟项目走，人的等级不影响项目内功能。
--   · production_plan 无行 = free 档。tier → 具体 limit（人数上限 / AI / 高级权限配置）
--     的映射是代码常量（lib/plan.ts），库里只存档名——改上限不动库。
--   · internal（即「level99」内部档）：建项目直接落最高档 production_plan 行；
--     own 的项目计费豁免——豁免在计费时查**当前 owner** 的档位推导，不物化到项目
--     （owner 转移后账单责任随人走）。
--   · billing_exempt = 项目级豁免（「特邀项目」），与 owner 级豁免正交，**落库记录**。
--     写点全库仅两个：管理员直接改库、兑换 grants_exempt 码。豁免 ≠ 不记账：
--     ai_usage 等账本照记，只在出账层归零。
--   · plan_code 没有任何创建界面：管理员手工 INSERT 生成，用户/owner 兑换消费。

CREATE TABLE IF NOT EXISTS user_plan (
  user_id    UUID        PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  tier       TEXT        NOT NULL,
  source     TEXT        NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS production_plan (
  production_id  TEXT        PRIMARY KEY REFERENCES production(id) ON DELETE CASCADE,
  tier           TEXT        NOT NULL,
  billing_exempt BOOLEAN     NOT NULL DEFAULT false,
  exempt_note    TEXT        NULL,
  source         TEXT        NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_code (
  code          TEXT        PRIMARY KEY,
  kind          TEXT        NOT NULL CHECK (kind IN ('user_upgrade', 'production_upgrade')),
  grants_tier   TEXT        NOT NULL,
  grants_exempt BOOLEAN     NOT NULL DEFAULT false,
  exempt_note   TEXT        NULL,
  max_uses      INTEGER     NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  used_count    INTEGER     NOT NULL DEFAULT 0,
  expires_at    TIMESTAMPTZ NULL,
  note          TEXT        NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 兑换流水：谁、何时、兑了哪张码到哪（production_id 仅 production_upgrade 码有值）。
CREATE TABLE IF NOT EXISTS plan_code_redemption (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          TEXT        NOT NULL REFERENCES plan_code(code) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  production_id TEXT        NULL REFERENCES production(id) ON DELETE CASCADE,
  redeemed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plan_code_redemption_code_idx ON plan_code_redemption (code);

-- ── Backfill：等级体系只对新用户/新项目生效，存量零感知 ──────────────────────
-- 顺序敏感：internal 名单先落，随后的 creator 批量 ON CONFLICT 不会把他们降级。

-- 内部成员（level99）名单 → internal。按 user_profile 姓名匹配；部署前须先在库里
-- 核实显示名（name 与 display_name 可能不一致），对不上的留管理员手工 INSERT，
-- 不做模糊匹配。
INSERT INTO user_plan (user_id, tier, source)
SELECT user_id, 'internal', 'backfill:founding'
FROM user_profile
WHERE name IN ('王恺镔', '冯胤仪', '刘杰熙', '邱一航', '朱盈蕾')
   OR display_name IN ('王恺镔', '冯胤仪', '刘杰熙', '邱一航', '朱盈蕾')
ON CONFLICT (user_id) DO NOTHING;

-- 存量项目的 owner 全部补 creator：已经建过项目的人不能因为门上线而失去建项目能力。
INSERT INTO user_plan (user_id, tier, source)
SELECT DISTINCT owner_id, 'creator', 'backfill:existing-owner'
FROM production
ON CONFLICT (user_id) DO NOTHING;

-- 存量项目全部补最高档：现役团队功能（AI / 人数 / 权限配置）完全不受上线影响。
INSERT INTO production_plan (production_id, tier, source)
SELECT id, 'pro', 'backfill'
FROM production
ON CONFLICT (production_id) DO NOTHING;
