-- 策略配置中心基建（#236，2026-08-18）
--
-- production_policy = 【政策】类定式的 production 级开关。设计见 MindWeave
-- 《权限系统-不变量与策略汇总》§2.0（三形状 + 铁律）/ §5（键表）/ §6（语义层）。
--
-- 三条设计约束落在这张表上：
--
--  1. **value TEXT，不是 enabled BOOLEAN**。形状 C/L 有多档键（orphan_task_disposition
--     三档），布尔装不下；拆成多个布尔会配出非法组合。合法取值由 TS 词汇常量
--     （lib/policy-keys.ts）声明并在服务端白名单校验——SQL 侧不设 CHECK，否则
--     每加一个键都要一次 migration，与「新增权限键零 policy 代码」的目标冲突。
--
--  2. **落全量键，不稀疏**。建演出时把词汇表里每个键都落一行（ensureProductionPolicies）。
--     若稀疏、缺行回落代码默认，那么改一次代码默认值就会**静默改变所有未显式配置过
--     该键的存量演出的行为**，且不留痕迹。grant_template 没这个问题，正是因为它 seed
--     的目标 production_role_permission 是落行的——稀疏的只是模版那一层。
--
--  3. **改动要留痕**。策略改动是项目级、影响所有人的动作，比单条 grant 更需要审计；
--     production_policy_audit 记 who / when / 旧值→新值。
--
-- 本文件是纯 DDL：**不 seed 任何行**。默认值的单一事实源在 TS 词汇常量里，SQL 侧
-- 复制一份必然分叉；存量演出的落行由 ensureProductionPolicies 承担（建演出时、
-- 以及策略中心读接口进入时自愈补齐）。

CREATE TABLE IF NOT EXISTS production_policy (
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  policy_key    TEXT        NOT NULL,
  value         TEXT        NOT NULL,
  updated_by    UUID        NULL REFERENCES app_user(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (production_id, policy_key)
);

CREATE TABLE IF NOT EXISTS production_policy_audit (
  id            BIGSERIAL   PRIMARY KEY,
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  policy_key    TEXT        NOT NULL,
  old_value     TEXT        NOT NULL,
  new_value     TEXT        NOT NULL,
  changed_by    UUID        NULL REFERENCES app_user(id),
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS production_policy_audit_prod_time_idx
  ON production_policy_audit (production_id, changed_at DESC);
