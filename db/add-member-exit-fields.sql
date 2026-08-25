-- #141 成员退出（方案 B）：状态成因列 + 状态变更审计表。
--
-- 与 db/migrate-member-exit-states.sql 配套（那一支收窄枚举，这一支补元数据）。

-- ── production_member 上的成因列 ──────────────────────────────────────────────
-- 光有 status 分不清「他自己退的」和「他被停用了」。这两件事在结算、署名与争议
-- 里是两回事，必须在数据上分得开。三列都只描述**当前**状态；完整轨迹在下面的
-- 审计表里，本行只是最近一次变更的冗余快照（名册列表要它，不想每行去 join）。

ALTER TABLE production_member
  -- 当前非 active 状态的成因：self=成员自助退出，admin=人事处置（停用/踢出）。
  -- 回到 active 时置回 NULL——它描述的是「现在为什么不在职」，不是历史。
  ADD COLUMN IF NOT EXISTS status_source TEXT NULL,
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS status_changed_by UUID NULL REFERENCES app_user(id);

-- 值域 CHECK 显式命名（不用 ADD COLUMN 的内联形式）：内联会生成自动名，
-- 后续要改就得先猜名字再 DROP——add-revoked-reason-member-removed.sql 踩过这个坑。
ALTER TABLE production_member
  DROP CONSTRAINT IF EXISTS production_member_status_source_value_check;
ALTER TABLE production_member
  ADD CONSTRAINT production_member_status_source_value_check
  CHECK (status_source IS NULL OR status_source IN ('self', 'admin'));

-- 「active ⇔ status_source IS NULL」这条跨列 CHECK 装在 migrate-member-exit-states.sql，
-- 不在这里：应用顺序是字母序，本文件先跑，此刻库里可能还有 pending_exit/disputed 残留行
-- （它们没有成因值），装了会直接失败。那支迁移先把残留行归一，再装约束。

-- ── 状态变更审计 ──────────────────────────────────────────────────────────────
-- 一张表同时承担两件事：
--   处置行（to_status NOT NULL）—— 真的改了状态：自助退出 / 停用 / 复职 / 确认离组
--   表态行（to_status IS NULL） —— 只留态度，不动访问权：不认可此退出 / 附议确认
--
-- 「不认可」在方案 A 里是一个状态（disputed）。它不该是状态：它不改变任何人能看到
-- 什么，唯一的价值是在结算/署名争议时作为证据。所以它是审计事实，一条行而已。
-- 同一个人可以多次进出剧组，所以轨迹必须是多行，不能是 member 行上的几列。
--
-- id 用 BIGSERIAL：纯审计日志，不被 URL 寻址、不做外部引用，与既有的
-- production_policy_audit 同形。TEXT short id 定式针对的是实体表。

CREATE TABLE IF NOT EXISTS production_member_status_audit (
  id            BIGSERIAL   PRIMARY KEY,
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  action        TEXT        NOT NULL CHECK (action IN (
                              'self_exit',     -- 成员自助退出 → suspended
                              'suspend',       -- 人事停用     → suspended
                              'restore',       -- 复职         → active
                              'confirm_exit',  -- 确认离组     → exited
                              'object',        -- 不认可此退出（不动状态）
                              'endorse'        -- 附议：确认他确实走了（不动状态）
                            )),
  from_status   TEXT        NOT NULL,
  to_status     TEXT        NULL,
  actor_id      UUID        NULL REFERENCES app_user(id),
  note          TEXT        NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 表态行不改状态，处置行必须改。两者不能混。
  CONSTRAINT pmsa_stance_has_no_target
    CHECK ((action IN ('object', 'endorse')) = (to_status IS NULL))
);

CREATE INDEX IF NOT EXISTS pmsa_member_time_idx
  ON production_member_status_audit (production_id, user_id, created_at DESC);
