-- Cue 表权限模版体系（§3.5，2026-08-13 用户设计定稿）。
--
--   dept_cue_list_template：类型 × 权限声明表——一张表统一"谁能建"（can_create）
--   与"谁受益什么"（permissions 纯相对键数组，全部可实例化）。
--   创建定式（C-1 进化）：can_create 门 → 建表后 ∀声明部门按数组发实例区间键
--   （production_dept_permission，自确认进入/伞语义下传/退出 recompute 撤销）。
--
--   迁移：production_dept.allowed_cue_types 数组 → 声明行（can_create=true +
--   设计全档数组，保真"工作部门"语义，§3.2 设计档含 grants@edit）。
--   数组列保留待后续清洁（与 dept.permissions 同批）。
--
-- 幂等，可重复执行。

BEGIN;

CREATE TABLE IF NOT EXISTS dept_cue_list_template (
  production_id  TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  dept_id        UUID NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  template       TEXT NOT NULL,
  can_create     BOOLEAN NOT NULL DEFAULT false,
  permissions    TEXT[] NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dept_id, template)
);

CREATE INDEX IF NOT EXISTS dept_cue_list_template_prod_idx
  ON dept_cue_list_template (production_id, template);

-- ── 数组迁移（幂等：已有声明行的 (dept,template) 跳过）─────────────────────────
INSERT INTO dept_cue_list_template (production_id, dept_id, template, can_create, permissions)
SELECT pd.production_id, pd.id, t.template, true,
       ARRAY['@view', '@edit', 'cues@create', 'cues@delete', 'grants@edit']
FROM production_dept pd
CROSS JOIN LATERAL unnest(pd.allowed_cue_types) AS t(template)
ON CONFLICT (dept_id, template) DO NOTHING;

COMMIT;
