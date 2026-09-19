-- Phase 2 (#137): production_member 新增 supervisor_id 和 status 字段
-- supervisor_id 循环引用防护在应用层实现（不允许 A→B→A 等循环链）。

ALTER TABLE production_member
  ADD COLUMN IF NOT EXISTS supervisor_id UUID REFERENCES app_user(id) NULL,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending_exit', 'disputed', 'exited', 'suspended'));
