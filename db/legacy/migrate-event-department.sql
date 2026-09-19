-- Phase 3 (#164): event_department / event_department_member → production_dept / production_dept_member
--
-- 迁移规则：
--   - 仅迁移 kind='dept' 的部门；'group' 类型按 PRD D1 暂时搁置，不迁移。
--   - 仅迁移 is_member=true 的成员行；is_member=false（仅 POC 关联但非成员）不迁移。
--   - event_department.id 是 TEXT PK；production_dept.id 是 UUID，通过临时映射表关联。
--   - permissions[]：若部门内有成员通过 production_member_role 持有 event:edit，
--     则视为 SM 级别部门，写入 ARRAY['event:edit','report:edit','tech_req:edit']；否则 '{}'。
--   - 幂等：ON CONFLICT DO NOTHING；再次执行时映射表 new_id 修正为已存在行的实际 UUID。
--
-- event_department 表数据保留不删除（event_tech_req 等表仍有 FK 引用）。
--
-- 补填 resource_dept_manage：add-event-resource-grants.sql 在 production_dept 为空时运行，
--   导致 1b / 2b / 3a / 3b / 3c 全部 0 行插入。本 migration 在 production_dept /
--   production_dept_member 填充完毕后重跑同等幂等 INSERT，补齐缺失记录。

-- ── Step 1：构建 old_id → new_id 映射 ──────────────────────────────────────────
CREATE TEMP TABLE IF NOT EXISTS _event_dept_id_map (
  old_id TEXT PRIMARY KEY,
  new_id UUID NOT NULL DEFAULT gen_random_uuid()
);

INSERT INTO _event_dept_id_map (old_id)
SELECT id FROM event_department WHERE kind = 'dept'
ON CONFLICT (old_id) DO NOTHING;

-- ── Step 2：迁移 production_dept（含 permissions[] 推断） ──────────────────────
INSERT INTO production_dept (id, production_id, name, display_order, chat_id, permissions)
SELECT
  m.new_id,
  ed.production_id,
  ed.name,
  ed.display_order,
  ed.chat_id,
  -- 若该部门有 is_member=true 的成员通过 production_member_role 持有 event:edit，
  -- 则视为 SM 级别部门，赋予完整 SM 权限集；否则保持空。
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM event_department_member edm2
      JOIN production_member_role pmr
        ON pmr.production_id = ed.production_id
       AND pmr.user_id = edm2.user_id
      JOIN production_role_permission prp ON prp.role_id = pmr.role_id
      WHERE edm2.department_id = ed.id
        AND edm2.is_member = true
        AND prp.permission_key = 'event:edit'
    )
    THEN ARRAY['event:edit', 'report:edit', 'tech_req:edit']
    ELSE '{}'::TEXT[]
  END AS permissions
FROM _event_dept_id_map m
JOIN event_department ed ON ed.id = m.old_id
ON CONFLICT DO NOTHING;

-- ── Step 3：幂等修正 — 将映射表中因冲突未插入的 new_id 更新为实际 UUID ──────────
UPDATE _event_dept_id_map m
SET new_id = pd.id
FROM event_department ed
JOIN production_dept pd
  ON pd.production_id = ed.production_id
 AND pd.name          = ed.name
 AND pd.parent_id     IS NULL
WHERE m.old_id = ed.id
  AND m.new_id <> pd.id;

-- ── Step 4：迁移 production_dept_member ───────────────────────────────────────
INSERT INTO production_dept_member (production_id, user_id, dept_id, is_poc)
SELECT ed.production_id, edm.user_id, m.new_id, edm.is_poc
FROM event_department_member edm
JOIN event_department ed ON ed.id = edm.department_id
JOIN _event_dept_id_map m ON m.old_id = edm.department_id
WHERE edm.is_member = true
ON CONFLICT (user_id, dept_id) DO NOTHING;

-- ── Step 5：清理临时表 ─────────────────────────────────────────────────────────
DROP TABLE _event_dept_id_map;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 补填 resource_dept_manage（Steps 6–10 与 add-event-resource-grants.sql 中的
-- 1b / 2b / 3a / 3b / 3c 完全对应，幂等重跑即可补齐之前因 production_dept 为空
-- 而未能插入的行。已存在行因 ON CONFLICT DO NOTHING 不受影响）。
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Step 6（补 1b）：SM 部门 → event 实例的 resource_dept_manage ─────────────
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

-- ── Step 7（补 2b）：SM 部门 → report 实例的 resource_dept_manage ───────────
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

-- ── Step 8（补 3a）：tech_req 指定部门 POC 的 manage resource_grant ───────────
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
  ON pd_mapped.production_id = pe.production_id
 AND pd_mapped.name = ed.name
JOIN production_dept_member pdm
  ON pdm.dept_id = pd_mapped.id
 AND pdm.is_poc = true
WHERE etr.department_id IS NOT NULL
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

-- ── Step 9（补 3b）：tech_req 指定部门的 resource_dept_manage ────────────────
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

-- ── Step 10（补 3c）：SM 部门 → tech_req 实例的 resource_dept_manage ──────────
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
