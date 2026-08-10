-- Phase 6: 为 production_role 新增 is_deprecated 标记列。
-- 在 migrate-assistant-roles.sql 运行后，复合职位行会被标记为 deprecated。
-- 旧行不删除（保留 FK 引用稳定性），应用层过滤 is_deprecated=false 展示。

ALTER TABLE production_role
  ADD COLUMN IF NOT EXISTS is_deprecated BOOLEAN NOT NULL DEFAULT false;
