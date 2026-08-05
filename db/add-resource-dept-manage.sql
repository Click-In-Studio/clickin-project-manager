-- Phase 3 (#163): resource_dept_manage — 部门-资源结构性管理权。
-- 这不是 grant 表，而是信号表，记录"哪个部门对哪个资源实例有管理责任"。
-- 它决定该部门的 POC 和匹配 permissions[] 的成员处于免审批区间，不直接放行任何操作。
-- 实际权限来源始终是 resource_grant / atomic_permission_grant。

CREATE TABLE IF NOT EXISTS resource_dept_manage (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  dept_id       UUID        NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  resource_type TEXT        NOT NULL,   -- 'cue_list' | 'event' | 'report' | 'tech_req' | ...
  resource_id   TEXT        NOT NULL DEFAULT '*',  -- 实例 ID；'*' = 该类型全部实例
  resource_sub  TEXT        NOT NULL DEFAULT '*',  -- 子类型；'*' = 全部
  established_by UUID       NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (production_id, dept_id, resource_type, resource_id, resource_sub)
);

CREATE INDEX IF NOT EXISTS rdm_production_resource_idx
  ON resource_dept_manage (production_id, resource_type, resource_id);

CREATE INDEX IF NOT EXISTS rdm_dept_idx
  ON resource_dept_manage (dept_id);
