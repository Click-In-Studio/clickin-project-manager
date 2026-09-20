-- 批E PR-E2 前置：script / dramaturgy 词汇四动词（resource_grant FK 前置）。
-- script 是单例资源（id 恒 '*'）；dramaturgy 域当前仅 imports 面。
-- 幂等，可重复执行。

BEGIN;

INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('script',     'view', 0), ('script',     'create', 0), ('script',     'edit', 0), ('script',     'delete', 0),
  ('dramaturgy', 'view', 0), ('dramaturgy', 'create', 0), ('dramaturgy', 'edit', 0), ('dramaturgy', 'delete', 0)
ON CONFLICT DO NOTHING;

COMMIT;
