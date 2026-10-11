-- migrate:up
-- 同次停机升级补齐范围的项目生命周期和通用自动摘要的批次依赖。
ALTER TABLE agent_memory_scope ADD COLUMN production_id TEXT NULL REFERENCES production(id) ON DELETE CASCADE;
ALTER TABLE agent_memory_scope ADD COLUMN dream_project_ids TEXT[] NOT NULL DEFAULT '{}';

-- migrate:down
ALTER TABLE agent_memory_scope DROP COLUMN dream_project_ids;
ALTER TABLE agent_memory_scope DROP COLUMN production_id;
