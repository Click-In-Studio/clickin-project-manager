-- 批D 前置：asset 隐私/公开标志。
--
-- 模型（用户敲定）：隐私 = 非公开 ∧ 无挂载边；可见 = 能力票 ∧ (is_public ∨ ∃挂载边:宿主可见)
--   ∨ publication@view（越隐私）。挂载=按方向让渡可见性（结构推导，永不落 grant 行）。
-- 保真：存量 asset 置公开是**数据迁移**，在 migrate-asset-rest.sql 中执行
--   （CI 会在测试 harness 之前直接应用 add 文件——add 里不能藏存量数据语义）。
--   此处只建列；新建默认隐私。
--
-- 幂等，可重复执行。

BEGIN;

ALTER TABLE asset ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;

COMMIT;
