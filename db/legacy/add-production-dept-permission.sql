-- 权限REST化 批A：dept 免审批区间表（六步判定链第 3 步的资格源）。
--
-- 取代 production_dept.permissions TEXT[] 数组的终局形态：与
-- production_role_permission / production_member_permission 同构，
-- permission_key 同词汇（迁移期原子键 / REST 化后节点串 node:<type>/<id>[/<sub>]@<verb>）。
--
-- 实例级资格行（如 node:cue_list/<id>/cues@edit）在资源创建时随 resource_dept_manage
-- 一起写入归属 dept；数组列在各批迁移完成后于终局退役。
--
-- 以 postgres 用户执行：
--   psql -U postgres -d script_editor -f db/add-production-dept-permission.sql

CREATE TABLE IF NOT EXISTS production_dept_permission (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id  TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  dept_id        UUID        NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  permission_key TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dept_id, permission_key)
);

CREATE INDEX IF NOT EXISTS production_dept_permission_prod_idx
  ON production_dept_permission (production_id, dept_id);
