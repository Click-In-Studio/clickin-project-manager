-- Phase 2 (#137): production_dept + production_dept_member
-- 两张表合并为一个文件，确保 production_dept 在 production_dept_member 之前建立（FK 依赖）。
-- 数据迁移（从 event_department 迁入）在 Phase 3 的 migrate-event-department.sql 中进行。

-- ── production_dept（替代 event_department）──────────────────────────────────
CREATE TABLE IF NOT EXISTS production_dept (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  parent_id       UUID        REFERENCES production_dept(id) NULL,  -- NULL = 顶级部门
  permissions     TEXT[]      NOT NULL DEFAULT '{}',                -- 向下继承给子部门成员（免审批区间）
  allowed_cue_types TEXT[]    NOT NULL DEFAULT '{}',                -- 本部门可创建的 cue 类型
  display_order   INTEGER     NOT NULL DEFAULT 0,
  chat_id         TEXT,                                             -- 飞书群 chat_id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 用函数式 unique index 处理 parent_id IS NULL 时 UNIQUE 约束不生效的问题
CREATE UNIQUE INDEX IF NOT EXISTS production_dept_name_unique_idx
  ON production_dept (production_id, name, COALESCE(parent_id::text, ''));

CREATE INDEX IF NOT EXISTS production_dept_production_idx
  ON production_dept (production_id, display_order);

CREATE INDEX IF NOT EXISTS production_dept_parent_idx
  ON production_dept (parent_id);

-- ── production_dept_member（替代 event_department_member）────────────────────
CREATE TABLE IF NOT EXISTS production_dept_member (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  dept_id         UUID        NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  is_poc          BOOLEAN     NOT NULL DEFAULT false,
  poc_extra_permissions   TEXT[] NOT NULL DEFAULT '{}',       -- POC 额外获得的权限
  poc_blocked_permissions TEXT[] NOT NULL DEFAULT '{}',       -- POC 被屏蔽的权限（含原 poc_block_write_from_children 语义）
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, dept_id)
);

CREATE INDEX IF NOT EXISTS pdm_prod_user_idx ON production_dept_member (production_id, user_id);
CREATE INDEX IF NOT EXISTS pdm_dept_idx      ON production_dept_member (dept_id);
