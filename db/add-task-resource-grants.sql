-- Phase 5c: 回填现有 event_tech_req 的 resource_grant 和 resource_dept_manage。
-- 新建 tech_req 已由 writeTechReqGrants() 自动写入；本脚本补齐历史数据。
-- 幂等：ON CONFLICT DO NOTHING，可安全重复执行。
-- 注意：resource_type 仍为 'tech_req'；schema rename 由独立 PR 完成。

-- 1. 每个 tech_req 的指派部门 POC 获得 manage 级 direct grant。
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by)
SELECT DISTINCT
  pe.production_id,
  pdm.user_id,
  'tech_req',
  etr.id,
  '*',
  'manage',
  'direct',
  pdm.user_id
FROM event_tech_req etr
JOIN production_event pe ON pe.id = etr.event_id
JOIN event_department ed ON ed.id = etr.department_id
JOIN production_dept pd_mapped
  ON pd_mapped.production_id = pe.production_id AND pd_mapped.name = ed.name
JOIN production_dept_member pdm ON pdm.dept_id = pd_mapped.id AND pdm.is_poc = true
WHERE etr.department_id IS NOT NULL
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

-- 2. 指派部门本身获得 resource_dept_manage。
INSERT INTO resource_dept_manage
  (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
SELECT DISTINCT
  pe.production_id,
  pd_mapped.id,
  'tech_req',
  etr.id,
  '*',
  pe.created_by
FROM event_tech_req etr
JOIN production_event pe ON pe.id = etr.event_id
JOIN event_department ed ON ed.id = etr.department_id
JOIN production_dept pd_mapped
  ON pd_mapped.production_id = pe.production_id AND pd_mapped.name = ed.name
WHERE etr.department_id IS NOT NULL
ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING;

-- 3. 所有 SM 部门（permissions[] 含 'event:edit'）获得 resource_dept_manage。
INSERT INTO resource_dept_manage
  (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
SELECT DISTINCT
  pe.production_id,
  pd.id,
  'tech_req',
  etr.id,
  '*',
  pe.created_by
FROM event_tech_req etr
JOIN production_event pe ON pe.id = etr.event_id
JOIN production_dept pd ON pd.production_id = pe.production_id
WHERE 'event:edit' = ANY(pd.permissions)
ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING;
