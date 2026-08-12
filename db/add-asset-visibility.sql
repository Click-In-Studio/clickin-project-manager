-- 批D 前置：asset 隐私/公开标志。
--
-- 模型（用户敲定）：隐私 = 非公开 ∧ 无挂载边；可见 = 能力票 ∧ (is_public ∨ ∃挂载边:宿主可见)
--   ∨ publication@view（越隐私）。挂载=按方向让渡可见性（结构推导，永不落 grant 行）。
-- 保真：存量 asset 全部置公开（老世界成员皆可见，含 11 个无挂载资产）；
--   新建默认隐私（列 default false），隐私语义只对新建生效。
--
-- 幂等，可重复执行。

BEGIN;

ALTER TABLE asset ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE asset ALTER COLUMN is_public SET DEFAULT false;

COMMIT;
