-- Phase 5b: 回填现有 event_report 的 resource_grant 和 resource_dept_manage。
-- 新建 report 已由 writeReportGrants() 自动写入；本脚本补齐历史数据。
-- 幂等：ON CONFLICT DO NOTHING，可安全重复执行。

-- 1. 每个 report 的创建者获得 manage 级 direct grant。
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by)
SELECT
  pe.production_id,
  er.created_by,
  'report',
  er.id,
  '*',
  'manage',
  'direct',
  er.created_by
FROM event_report er
JOIN production_event pe ON pe.id = er.event_id
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

-- 2. 所有 permissions[] 含 'event:edit' 的 production_dept 获得 resource_dept_manage（与 event 同一管理域）。
INSERT INTO resource_dept_manage
  (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
SELECT DISTINCT
  pe.production_id,
  pd.id,
  'report',
  er.id,
  '*',
  er.created_by
FROM event_report er
JOIN production_event pe ON pe.id = er.event_id
JOIN production_dept pd ON pd.production_id = pe.production_id
WHERE 'event:edit' = ANY(pd.permissions)
ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING;
