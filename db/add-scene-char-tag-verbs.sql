-- 批E PR-E1 前置：character / tag_group 词汇四动词（resource_grant FK 前置）。
-- tag_option 并入 tag_group 树（options 子集合），无独立词汇。
-- 幂等，可重复执行。

BEGIN;

INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('character', 'view', 0), ('character', 'create', 0), ('character', 'edit', 0), ('character', 'delete', 0),
  ('tag_group', 'view', 0), ('tag_group', 'create', 0), ('tag_group', 'edit', 0), ('tag_group', 'delete', 0)
ON CONFLICT DO NOTHING;

COMMIT;
