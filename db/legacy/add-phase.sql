-- Phase（项目大阶段）：与 milestone（时间节点）平级的 top-level 概念。
--   milestone = 点（end_date），phase = 区间（start_date ~ end_date?）。
--   dept_id NULL = production-level；非 NULL = department-specific（仅 kind='dept'，
--   应用层校验）。部门解散时 SET NULL 升级为全局（与 task.department_id 同语义）。
--   end_date 可空 = 尾巴未定（排练期常态）；甘特图画到轴右缘渐隐。

CREATE TABLE IF NOT EXISTS phase (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  dept_id       UUID REFERENCES production_dept(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  start_date    DATE NOT NULL,
  end_date      DATE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT phase_date_order_check CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS phase_production_idx ON phase(production_id, start_date);

-- phase ↔ milestone 多对多：两者无从属关系。正当场景——「首演」这种全局节点
-- 同时是多个部门 phase 的收尾。
CREATE TABLE IF NOT EXISTS phase_milestone (
  phase_id     TEXT NOT NULL REFERENCES phase(id) ON DELETE CASCADE,
  milestone_id TEXT NOT NULL REFERENCES milestone(id) ON DELETE CASCADE,
  PRIMARY KEY (phase_id, milestone_id)
);

CREATE INDEX IF NOT EXISTS phase_milestone_milestone_idx ON phase_milestone(milestone_id);

-- task ↔ phase 多对多（任务=项目小阶段，挂在大阶段下）。接替 task_milestone
-- （migrate-drop-task-milestone.sql 退役，线上零数据）。
-- 不约束 task 起止 ⊆ phase 区间，前端仅软提示（与原 task_milestone 同规范）。
CREATE TABLE IF NOT EXISTS task_phase (
  task_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  phase_id TEXT NOT NULL REFERENCES phase(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, phase_id)
);

CREATE INDEX IF NOT EXISTS task_phase_phase_idx ON task_phase(phase_id);

-- 新 resource_type 必须先注册合法动词行（schema.sql resource_permission_level 规约）
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('phase', 'view', 0), ('phase', 'create', 0), ('phase', 'edit', 0), ('phase', 'delete', 0)
ON CONFLICT DO NOTHING;
