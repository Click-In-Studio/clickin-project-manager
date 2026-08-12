-- 权限REST化 批B：task 创建路径落库（删除权自动授权按路径区分——用户规范）。
--   explicit  = organizer 显式创建（部门 POC 无自动删除权）
--   dept_auto = 关联部门时自动创建的待确认 task（部门 POC 有删除权）
-- 以 postgres 用户执行：
--   psql -U postgres -d script_editor -f db/add-task-created-via.sql

ALTER TABLE event_tech_req ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'explicit'
  CHECK (created_via IN ('explicit', 'dept_auto'));
