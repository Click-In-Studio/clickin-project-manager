-- Phase 3 (#164): event_department / event_department_member → production_dept / production_dept_member
--
-- 迁移规则：
--   - 仅迁移 kind='dept' 的部门；'group' 类型按 PRD D1 暂时搁置，不迁移。
--   - 仅迁移 is_member=true 的成员行；is_member=false（仅 POC 关联但非成员）不迁移。
--   - event_department.id 是 TEXT PK；production_dept.id 是 UUID，通过临时映射表关联。
--   - 幂等：production_dept ON CONFLICT DO NOTHING；成员表 ON CONFLICT DO NOTHING。
--     再次执行时，映射表中 new_id 会被更新为已存在行的实际 UUID，确保成员 INSERT 使用正确 dept_id。
--
-- event_department 表数据保留不删除（其他表如 event_tech_req 仍有 FK 引用）。

-- ── Step 1：构建 old_id → new_id 映射 ──────────────────────────────────────────
CREATE TEMP TABLE IF NOT EXISTS _event_dept_id_map (
  old_id TEXT    PRIMARY KEY,
  new_id UUID    NOT NULL DEFAULT gen_random_uuid()
);

INSERT INTO _event_dept_id_map (old_id)
SELECT id FROM event_department WHERE kind = 'dept'
ON CONFLICT (old_id) DO NOTHING;

-- ── Step 2：迁移 production_dept ──────────────────────────────────────────────
INSERT INTO production_dept (id, production_id, name, display_order, chat_id)
SELECT m.new_id, ed.production_id, ed.name, ed.display_order, ed.chat_id
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
