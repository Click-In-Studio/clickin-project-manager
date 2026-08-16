-- 批F 前置：治理域词汇四动词（resource_grant FK 前置）。
-- production=根实例（id 恒 '*'）；org_dept=production_dept 组织树
-- （与批C3 的 dept=event_department 业务部门区分）；producer/member/role/
-- milestone/announcement 各治理类型。
-- 幂等，可重复执行。

BEGIN;

INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('production',   'view', 0), ('production',   'create', 0), ('production',   'edit', 0), ('production',   'delete', 0),
  ('member',       'view', 0), ('member',       'create', 0), ('member',       'edit', 0), ('member',       'delete', 0),
  ('producer',     'view', 0), ('producer',     'create', 0), ('producer',     'edit', 0), ('producer',     'delete', 0),
  ('role',         'view', 0), ('role',         'create', 0), ('role',         'edit', 0), ('role',         'delete', 0),
  ('org_dept',     'view', 0), ('org_dept',     'create', 0), ('org_dept',     'edit', 0), ('org_dept',     'delete', 0),
  ('milestone',    'view', 0), ('milestone',    'create', 0), ('milestone',    'edit', 0), ('milestone',    'delete', 0),
  ('announcement', 'view', 0), ('announcement', 'create', 0), ('announcement', 'edit', 0), ('announcement', 'delete', 0)
ON CONFLICT DO NOTHING;

COMMIT;
