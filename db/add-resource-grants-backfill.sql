-- Phase 5: backfill resource_grant + resource_dept_manage for existing
-- event / event_report / event_tech_req resources.
--
-- Strategy:
--   event      → creator gets manage grant; SM depts (event:edit in permissions[]) get resource_dept_manage
--   report     → creator gets manage grant; same SM depts get resource_dept_manage
--   tech_req   → dept POC(s) get manage grant; assigned dept + SM depts get resource_dept_manage
--   note       → no individual backfill (isInCall path remains authoritative for legacy notes)

-- ─── 1. EVENT grants ──────────────────────────────────────────────────────────

-- 1a. resource_grant(manage, direct) for event creators
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
WHERE pe.created_by IS NOT NULL
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

-- 1b. resource_dept_manage for depts with 'event:edit' in permissions[]
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
JOIN production_dept pd
  ON pd.production_id = pe.production_id
  AND 'event:edit' = ANY(pd.permissions)
WHERE pe.created_by IS NOT NULL
ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING;

-- ─── 2. REPORT grants ─────────────────────────────────────────────────────────

-- 2a. resource_grant(manage, direct) for report creators
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
WHERE er.created_by IS NOT NULL
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

-- 2b. resource_dept_manage for SM depts (same as event's depts)
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
JOIN production_dept pd
  ON pd.production_id = pe.production_id
  AND 'event:edit' = ANY(pd.permissions)
WHERE er.created_by IS NOT NULL
ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING;

-- ─── 3. TECH_REQ grants ───────────────────────────────────────────────────────

-- 3a. resource_grant(manage, direct) for POC(s) of assigned dept
--     event_tech_req.department_id → event_department.id (TEXT) → production_dept.id (UUID) by name
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
-- map event_department → production_dept by name
JOIN event_department ed ON ed.id = etr.department_id
JOIN production_dept pd_mapped
  ON pd_mapped.production_id = pe.production_id
  AND pd_mapped.name = ed.name
JOIN production_dept_member pdm
  ON pdm.dept_id = pd_mapped.id
  AND pdm.is_poc = true
WHERE etr.department_id IS NOT NULL
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

-- 3b. resource_dept_manage for assigned dept
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
  ON pd_mapped.production_id = pe.production_id
  AND pd_mapped.name = ed.name
WHERE etr.department_id IS NOT NULL
  AND pe.created_by IS NOT NULL
ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING;

-- 3c. resource_dept_manage for SM depts (can self-confirm edit on any tech_req)
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
JOIN production_dept pd
  ON pd.production_id = pe.production_id
  AND 'event:edit' = ANY(pd.permissions)
WHERE pe.created_by IS NOT NULL
ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING;
