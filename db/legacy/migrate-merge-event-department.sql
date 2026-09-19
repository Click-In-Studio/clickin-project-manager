-- ═══════════════════════════════════════════════════════════════════════════
-- 并表迁移：event_department（+member）→ production_dept（+member）
--
-- 背景：两表为同名镜像（组织树 production_dept=权限宿主；event_department=
-- notes 锚/事件业务 FK 家族），靠名字逻辑对应、无 FK、成员/POC/chat_id 双写
-- 且互不同步——POC 双写脱节会导致 viaPoc/notes 归因与管理后台显示不一致。
-- 终局：单表 production_dept（加 kind 列承接"用户组"语义），六张 FK 表改指，
-- 成员并入 production_dept_member，dept 权限实例 id 空间随之切换。
--
-- 同批清理死账：production_dept.permissions / allowed_cue_types（数组机制
-- 已由 production_dept_permission / dept_cue_list_template 接管）、
-- production_dept_member.poc_extra_permissions / poc_blocked_permissions
-- （判定侧零消费）。
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0. production_dept 承接 kind（'dept'=部门，可被提 notes；'group'=用户组，仅选人）
ALTER TABLE production_dept ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'dept';

-- ── 1. 映射表：同名精确映射 ─────────────────────────────────────────────────
CREATE TEMP TABLE ed_map ON COMMIT DROP AS
SELECT ed.id AS old_id, pd.id AS new_id
FROM event_department ed
JOIN production_dept pd
  ON pd.production_id = ed.production_id AND pd.name = ed.name;

-- ── 2. 孤儿行补建（无同名组织树行；含 kind='group' 用户组），并入映射 ────────
INSERT INTO production_dept (production_id, name, kind, display_order, chat_id)
SELECT ed.production_id, ed.name, ed.kind, ed.display_order, ed.chat_id
FROM event_department ed
WHERE NOT EXISTS (SELECT 1 FROM ed_map m WHERE m.old_id = ed.id);

INSERT INTO ed_map
SELECT ed.id, pd.id
FROM event_department ed
JOIN production_dept pd
  ON pd.production_id = ed.production_id AND pd.name = ed.name
WHERE NOT EXISTS (SELECT 1 FROM ed_map m WHERE m.old_id = ed.id);

-- ── 3. kind / chat_id 汇入既有映射行 ────────────────────────────────────────
UPDATE production_dept pd SET kind = ed.kind
FROM ed_map m JOIN event_department ed ON ed.id = m.old_id
WHERE pd.id = m.new_id AND ed.kind <> 'dept' AND pd.kind = 'dept';

UPDATE production_dept pd SET chat_id = ed.chat_id
FROM ed_map m JOIN event_department ed ON ed.id = m.old_id
WHERE pd.id = m.new_id AND pd.chat_id IS NULL AND ed.chat_id IS NOT NULL;

-- ── 4. 成员并表（is_poc 取 OR；is_member 列语义废弃——非成员 POC 一并转正）──
INSERT INTO production_dept_member (production_id, user_id, dept_id, is_poc)
SELECT ed.production_id, edm.user_id, m.new_id, edm.is_poc
FROM event_department_member edm
JOIN event_department ed ON ed.id = edm.department_id
JOIN ed_map m ON m.old_id = edm.department_id
ON CONFLICT (user_id, dept_id)
DO UPDATE SET is_poc = production_dept_member.is_poc OR EXCLUDED.is_poc;

-- ── 5. 六张 FK 表：值重写 → 列改型 UUID → FK 改指 production_dept ────────────
-- event_participant.department_id（SET NULL）
ALTER TABLE event_participant DROP CONSTRAINT event_participant_department_id_fkey;
UPDATE event_participant t SET department_id = m.new_id::text
FROM ed_map m WHERE t.department_id = m.old_id;
ALTER TABLE event_participant
  ALTER COLUMN department_id TYPE UUID USING department_id::uuid;
ALTER TABLE event_participant
  ADD CONSTRAINT event_participant_department_id_fkey
  FOREIGN KEY (department_id) REFERENCES production_dept(id) ON DELETE SET NULL;

-- event_call_time.department_id（SET NULL）
ALTER TABLE event_call_time DROP CONSTRAINT event_call_time_department_id_fkey;
UPDATE event_call_time t SET department_id = m.new_id::text
FROM ed_map m WHERE t.department_id = m.old_id;
ALTER TABLE event_call_time
  ALTER COLUMN department_id TYPE UUID USING department_id::uuid;
ALTER TABLE event_call_time
  ADD CONSTRAINT event_call_time_department_id_fkey
  FOREIGN KEY (department_id) REFERENCES production_dept(id) ON DELETE SET NULL;

-- event_tech_req.department_id（SET NULL）
ALTER TABLE event_tech_req DROP CONSTRAINT event_tech_req_department_id_fkey;
UPDATE event_tech_req t SET department_id = m.new_id::text
FROM ed_map m WHERE t.department_id = m.old_id;
ALTER TABLE event_tech_req
  ALTER COLUMN department_id TYPE UUID USING department_id::uuid;
ALTER TABLE event_tech_req
  ADD CONSTRAINT event_tech_req_department_id_fkey
  FOREIGN KEY (department_id) REFERENCES production_dept(id) ON DELETE SET NULL;

-- schedule_item_department.dept_id（CASCADE，PK 成分列）
ALTER TABLE schedule_item_department DROP CONSTRAINT schedule_item_department_dept_id_fkey;
UPDATE schedule_item_department t SET dept_id = m.new_id::text
FROM ed_map m WHERE t.dept_id = m.old_id;
ALTER TABLE schedule_item_department
  ALTER COLUMN dept_id TYPE UUID USING dept_id::uuid;
ALTER TABLE schedule_item_department
  ADD CONSTRAINT schedule_item_department_dept_id_fkey
  FOREIGN KEY (dept_id) REFERENCES production_dept(id) ON DELETE CASCADE;

-- event_report_note.department_id（CASCADE；notes 锚 id 空间切换）
ALTER TABLE event_report_note DROP CONSTRAINT event_report_note_department_id_fkey;
UPDATE event_report_note t SET department_id = m.new_id::text
FROM ed_map m WHERE t.department_id = m.old_id;
ALTER TABLE event_report_note
  ALTER COLUMN department_id TYPE UUID USING department_id::uuid;
ALTER TABLE event_report_note
  ADD CONSTRAINT event_report_note_department_id_fkey
  FOREIGN KEY (department_id) REFERENCES production_dept(id) ON DELETE CASCADE;

-- ── 6. dept 权限实例 id 重写（node 树 dept/<id>/notes 面；resource_id 存 uuid 文本）
UPDATE production_member_grant g SET resource_id = m.new_id::text
FROM ed_map m WHERE g.resource_type = 'dept' AND g.resource_id = m.old_id;

UPDATE approval_request r SET resource_id = m.new_id::text
FROM ed_map m WHERE r.resource_type = 'dept' AND r.resource_id = m.old_id;

-- ── 7. 退役两表 ─────────────────────────────────────────────────────────────
DROP TABLE event_department_member;
DROP TABLE event_department;

-- ── 8. 死列清理（机制已由行表/声明表接管，判定侧零消费）─────────────────────
ALTER TABLE production_dept
  DROP COLUMN IF EXISTS permissions,
  DROP COLUMN IF EXISTS allowed_cue_types;
ALTER TABLE production_dept_member
  DROP COLUMN IF EXISTS poc_extra_permissions,
  DROP COLUMN IF EXISTS poc_blocked_permissions;

COMMIT;
