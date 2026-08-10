-- Phase 5a: 回填现有 production_event 的 resource_grant 和 resource_dept_manage。
-- 新建 event 已由 writeEventGrants() 自动写入；本脚本补齐历史数据。
-- 幂等：ON CONFLICT DO NOTHING，可安全重复执行。

-- 1. 每个 event 的创建者获得 manage 级 direct grant。
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by)
SELECT
  pe.production_id,
  pe.created_by,
  'event',
  pe.id,
  '*',
  'manage',
  'direct',
  pe.created_by
FROM production_event pe
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

-- 2. 所有 permissions[] 含 'event:edit' 的 production_dept 获得 resource_dept_manage。
INSERT INTO resource_dept_manage
  (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
SELECT DISTINCT
  pe.production_id,
  pd.id,
  'event',
  pe.id,
  '*',
  pe.created_by
FROM production_event pe
JOIN production_dept pd ON pd.production_id = pe.production_id
WHERE 'event:edit' = ANY(pd.permissions)
ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING;

-- 3. 现有参演人员获得 assigned view grant（confirmed_by = event 创建者作为兜底）。
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by)
SELECT DISTINCT
  pe.production_id,
  ep.user_id,
  'event',
  pe.id,
  '*',
  'view',
  'assigned',
  pe.created_by
FROM event_participant ep
JOIN production_event pe ON pe.id = ep.event_id
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;
