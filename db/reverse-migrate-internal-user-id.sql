-- Reverse of migrate-internal-user-id.sql
-- Converts all UUID user_id columns back to TEXT open_id via feishu_user bridge.
-- Intended for local dev only (e.g., to export a pre-migration CI seed).
--
-- Run with: psql -v ON_ERROR_STOP=1 -d <db> -f reverse-migrate-internal-user-id.sql

BEGIN;

-- ── Rev-22. Reverse JSONB mentions: { userId } → { openId } ──────────────────

UPDATE comment c
SET mentions = (
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN t.elem ? 'userId' AND fu.open_id IS NOT NULL
          THEN (t.elem - 'userId') || jsonb_build_object('openId', fu.open_id)
        ELSE t.elem
      END ORDER BY t.ord
    ), '[]'::jsonb
  )
  FROM jsonb_array_elements(c.mentions) WITH ORDINALITY AS t(elem, ord)
  LEFT JOIN feishu_user fu ON fu.user_id = (t.elem->>'userId')::uuid
)
WHERE jsonb_array_length(c.mentions) > 0;

UPDATE event_report r
SET mentions = (
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN t.elem ? 'userId' AND fu.open_id IS NOT NULL
          THEN (t.elem - 'userId') || jsonb_build_object('openId', fu.open_id)
        ELSE t.elem
      END ORDER BY t.ord
    ), '[]'::jsonb
  )
  FROM jsonb_array_elements(r.mentions) WITH ORDINALITY AS t(elem, ord)
  LEFT JOIN feishu_user fu ON fu.user_id = (t.elem->>'userId')::uuid
)
WHERE jsonb_array_length(r.mentions) > 0;

UPDATE event_report_note n
SET mentions = (
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN t.elem ? 'userId' AND fu.open_id IS NOT NULL
          THEN (t.elem - 'userId') || jsonb_build_object('openId', fu.open_id)
        ELSE t.elem
      END ORDER BY t.ord
    ), '[]'::jsonb
  )
  FROM jsonb_array_elements(n.mentions) WITH ORDINALITY AS t(elem, ord)
  LEFT JOIN feishu_user fu ON fu.user_id = (t.elem->>'userId')::uuid
)
WHERE jsonb_array_length(n.mentions) > 0;

UPDATE event_report_reply rp
SET mentions = (
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN t.elem ? 'userId' AND fu.open_id IS NOT NULL
          THEN (t.elem - 'userId') || jsonb_build_object('openId', fu.open_id)
        ELSE t.elem
      END ORDER BY t.ord
    ), '[]'::jsonb
  )
  FROM jsonb_array_elements(rp.mentions) WITH ORDINALITY AS t(elem, ord)
  LEFT JOIN feishu_user fu ON fu.user_id = (t.elem->>'userId')::uuid
)
WHERE jsonb_array_length(rp.mentions) > 0;

-- ── Rev-21. asset_mount: created_by UUID → TEXT ──────────────────────────────

ALTER TABLE asset_mount ADD COLUMN IF NOT EXISTS created_by_old TEXT;
UPDATE asset_mount am
  SET created_by_old = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = am.created_by;
ALTER TABLE asset_mount ALTER COLUMN created_by_old SET NOT NULL;
ALTER TABLE asset_mount DROP CONSTRAINT IF EXISTS asset_mount_created_by_fk;
ALTER TABLE asset_mount DROP COLUMN IF EXISTS created_by;
ALTER TABLE asset_mount RENAME COLUMN created_by_old TO created_by;

-- ── Rev-20. asset: uploader_user_id → uploader_open_id ───────────────────────

ALTER TABLE asset ADD COLUMN IF NOT EXISTS uploader_open_id TEXT;
UPDATE asset a
  SET uploader_open_id = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = a.uploader_user_id;
ALTER TABLE asset ALTER COLUMN uploader_open_id SET NOT NULL;
DROP INDEX IF EXISTS asset_uploader_idx;
ALTER TABLE asset DROP CONSTRAINT IF EXISTS asset_uploader_user_fk;
ALTER TABLE asset DROP COLUMN IF EXISTS uploader_user_id;
CREATE INDEX IF NOT EXISTS asset_uploader_idx ON asset(uploader_open_id);

-- ── Rev-19. notification_subscription: user_id → open_id ─────────────────────

ALTER TABLE notification_subscription ADD COLUMN IF NOT EXISTS open_id TEXT;
UPDATE notification_subscription ns
  SET open_id = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = ns.user_id;
ALTER TABLE notification_subscription ALTER COLUMN open_id SET NOT NULL;
ALTER TABLE notification_subscription DROP CONSTRAINT IF EXISTS notification_subscription_pkey;
ALTER TABLE notification_subscription ADD PRIMARY KEY (open_id, notification_type);
ALTER TABLE notification_subscription DROP CONSTRAINT IF EXISTS notification_subscription_user_fk;
ALTER TABLE notification_subscription DROP COLUMN IF EXISTS user_id;

-- ── Rev-18. event_report_reply: user_id → open_id ────────────────────────────

ALTER TABLE event_report_reply ADD COLUMN IF NOT EXISTS open_id TEXT;
UPDATE event_report_reply err
  SET open_id = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = err.user_id;
ALTER TABLE event_report_reply ALTER COLUMN open_id SET NOT NULL;
ALTER TABLE event_report_reply DROP CONSTRAINT IF EXISTS event_report_reply_user_fk;
ALTER TABLE event_report_reply DROP COLUMN IF EXISTS user_id;

-- ── Rev-17. event_report_read: (report_id, user_id) PK → (report_id, open_id)

ALTER TABLE event_report_read ADD COLUMN IF NOT EXISTS open_id TEXT;
UPDATE event_report_read err
  SET open_id = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = err.user_id;
ALTER TABLE event_report_read ALTER COLUMN open_id SET NOT NULL;
ALTER TABLE event_report_read DROP CONSTRAINT IF EXISTS event_report_read_pkey;
ALTER TABLE event_report_read ADD PRIMARY KEY (report_id, open_id);
ALTER TABLE event_report_read DROP CONSTRAINT IF EXISTS event_report_read_user_fk;
ALTER TABLE event_report_read DROP COLUMN IF EXISTS user_id;

-- ── Rev-16. event_report_note: author_user_id → author_open_id ───────────────

ALTER TABLE event_report_note ADD COLUMN IF NOT EXISTS author_open_id TEXT;
UPDATE event_report_note ern
  SET author_open_id = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = ern.author_user_id;
ALTER TABLE event_report_note ALTER COLUMN author_open_id SET NOT NULL;
ALTER TABLE event_report_note DROP CONSTRAINT IF EXISTS event_report_note_author_fk;
ALTER TABLE event_report_note DROP COLUMN IF EXISTS author_user_id;

-- ── Rev-15. event_report: created_by UUID → TEXT ─────────────────────────────

ALTER TABLE event_report ADD COLUMN IF NOT EXISTS created_by_old TEXT;
UPDATE event_report er
  SET created_by_old = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = er.created_by;
ALTER TABLE event_report ALTER COLUMN created_by_old SET NOT NULL;
ALTER TABLE event_report DROP CONSTRAINT IF EXISTS event_report_created_by_fk;
ALTER TABLE event_report DROP COLUMN IF EXISTS created_by;
ALTER TABLE event_report RENAME COLUMN created_by_old TO created_by;

-- ── Rev-14. event_tech_assignee: (req_id, user_id) PK → (req_id, open_id) ────

ALTER TABLE event_tech_assignee ADD COLUMN IF NOT EXISTS open_id TEXT;
UPDATE event_tech_assignee eta
  SET open_id = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = eta.user_id;
ALTER TABLE event_tech_assignee ALTER COLUMN open_id SET NOT NULL;
ALTER TABLE event_tech_assignee DROP CONSTRAINT IF EXISTS event_tech_assignee_pkey;
ALTER TABLE event_tech_assignee ADD PRIMARY KEY (req_id, open_id);
ALTER TABLE event_tech_assignee DROP CONSTRAINT IF EXISTS event_tech_assignee_user_fk;
ALTER TABLE event_tech_assignee DROP COLUMN IF EXISTS user_id;

-- ── Rev-13. event_call_time: user_id → open_id ───────────────────────────────

ALTER TABLE event_call_time ADD COLUMN IF NOT EXISTS open_id TEXT;
UPDATE event_call_time ect
  SET open_id = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = ect.user_id;
ALTER TABLE event_call_time ALTER COLUMN open_id SET NOT NULL;
ALTER TABLE event_call_time DROP CONSTRAINT IF EXISTS event_call_time_user_fk;
ALTER TABLE event_call_time DROP COLUMN IF EXISTS user_id;

-- ── Rev-12. schedule_item_participant: (item_id, user_id) PK → (item_id, open_id)

ALTER TABLE schedule_item_participant ADD COLUMN IF NOT EXISTS open_id TEXT;
UPDATE schedule_item_participant sip
  SET open_id = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = sip.user_id;
ALTER TABLE schedule_item_participant ALTER COLUMN open_id SET NOT NULL;
ALTER TABLE schedule_item_participant DROP CONSTRAINT IF EXISTS schedule_item_participant_pkey;
ALTER TABLE schedule_item_participant ADD PRIMARY KEY (item_id, open_id);
ALTER TABLE schedule_item_participant DROP CONSTRAINT IF EXISTS schedule_item_participant_user_fk;
ALTER TABLE schedule_item_participant DROP COLUMN IF EXISTS user_id;

-- ── Rev-11. event_participant: UNIQUE (event_id, user_id) → (event_id, open_id)

ALTER TABLE event_participant ADD COLUMN IF NOT EXISTS open_id TEXT;
UPDATE event_participant ep
  SET open_id = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = ep.user_id;
ALTER TABLE event_participant ALTER COLUMN open_id SET NOT NULL;
ALTER TABLE event_participant DROP CONSTRAINT IF EXISTS event_participant_event_user_unique;
ALTER TABLE event_participant ADD CONSTRAINT event_participant_event_id_open_id_key UNIQUE (event_id, open_id);
ALTER TABLE event_participant DROP CONSTRAINT IF EXISTS event_participant_user_fk;
ALTER TABLE event_participant DROP COLUMN IF EXISTS user_id;

-- ── Rev-10. event_stage_manager: (event_id, user_id) PK → (event_id, open_id)

ALTER TABLE event_stage_manager ADD COLUMN IF NOT EXISTS open_id TEXT;
UPDATE event_stage_manager esm
  SET open_id = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = esm.user_id;
ALTER TABLE event_stage_manager ALTER COLUMN open_id SET NOT NULL;
ALTER TABLE event_stage_manager DROP CONSTRAINT IF EXISTS event_stage_manager_pkey;
ALTER TABLE event_stage_manager ADD PRIMARY KEY (event_id, open_id);
ALTER TABLE event_stage_manager DROP CONSTRAINT IF EXISTS event_stage_manager_user_fk;
ALTER TABLE event_stage_manager DROP COLUMN IF EXISTS user_id;

-- ── Rev-9. event_department_member: (department_id, user_id) PK → (department_id, open_id)

ALTER TABLE event_department_member ADD COLUMN IF NOT EXISTS open_id TEXT;
UPDATE event_department_member edm
  SET open_id = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = edm.user_id;
ALTER TABLE event_department_member ALTER COLUMN open_id SET NOT NULL;
ALTER TABLE event_department_member DROP CONSTRAINT IF EXISTS event_department_member_pkey;
ALTER TABLE event_department_member ADD PRIMARY KEY (department_id, open_id);
ALTER TABLE event_department_member DROP CONSTRAINT IF EXISTS event_department_member_user_fk;
ALTER TABLE event_department_member DROP COLUMN IF EXISTS user_id;

-- ── Rev-8. production_event: created_by UUID → TEXT ──────────────────────────

ALTER TABLE production_event ADD COLUMN IF NOT EXISTS created_by_old TEXT;
UPDATE production_event pe
  SET created_by_old = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = pe.created_by;
ALTER TABLE production_event ALTER COLUMN created_by_old SET NOT NULL;
ALTER TABLE production_event DROP CONSTRAINT IF EXISTS production_event_created_by_fk;
ALTER TABLE production_event DROP COLUMN IF EXISTS created_by;
ALTER TABLE production_event RENAME COLUMN created_by_old TO created_by;

-- ── Rev-7. cue_list_permission: (cue_list_id, user_id) PK → (cue_list_id, open_id)

ALTER TABLE cue_list_permission ADD COLUMN IF NOT EXISTS open_id TEXT;
UPDATE cue_list_permission clp
  SET open_id = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = clp.user_id;
ALTER TABLE cue_list_permission ALTER COLUMN open_id SET NOT NULL;
ALTER TABLE cue_list_permission DROP CONSTRAINT IF EXISTS cue_list_permission_pkey;
ALTER TABLE cue_list_permission ADD PRIMARY KEY (cue_list_id, open_id);
ALTER TABLE cue_list_permission DROP CONSTRAINT IF EXISTS cue_list_permission_user_fk;
ALTER TABLE cue_list_permission DROP COLUMN IF EXISTS user_id;

-- ── Rev-6. cue_list: created_by UUID → TEXT ──────────────────────────────────

ALTER TABLE cue_list ADD COLUMN IF NOT EXISTS created_by_old TEXT;
UPDATE cue_list cl
  SET created_by_old = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = cl.created_by;
ALTER TABLE cue_list ALTER COLUMN created_by_old SET NOT NULL;
ALTER TABLE cue_list DROP CONSTRAINT IF EXISTS cue_list_created_by_fk;
ALTER TABLE cue_list DROP COLUMN IF EXISTS created_by;
ALTER TABLE cue_list RENAME COLUMN created_by_old TO created_by;

-- ── Rev-5. comment: user_id → open_id ────────────────────────────────────────

ALTER TABLE comment ADD COLUMN IF NOT EXISTS open_id TEXT;
UPDATE comment c
  SET open_id = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = c.user_id;
ALTER TABLE comment ALTER COLUMN open_id SET NOT NULL;
ALTER TABLE comment DROP CONSTRAINT IF EXISTS comment_user_fk;
ALTER TABLE comment DROP COLUMN IF EXISTS user_id;

-- ── Rev-4. production_member_permission: (production_id, user_id, permission) PK → open_id

ALTER TABLE production_member_permission ADD COLUMN IF NOT EXISTS open_id TEXT;
UPDATE production_member_permission pmp
  SET open_id = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = pmp.user_id;
ALTER TABLE production_member_permission ALTER COLUMN open_id SET NOT NULL;
ALTER TABLE production_member_permission DROP CONSTRAINT IF EXISTS production_member_permission_pkey;
ALTER TABLE production_member_permission ADD PRIMARY KEY (production_id, open_id, permission);
ALTER TABLE production_member_permission DROP CONSTRAINT IF EXISTS production_member_permission_user_fk;
ALTER TABLE production_member_permission DROP COLUMN IF EXISTS user_id;

-- ── Rev-3. production_member: (production_id, user_id) PK → (production_id, open_id)

ALTER TABLE production_member ADD COLUMN IF NOT EXISTS open_id TEXT;
UPDATE production_member pm
  SET open_id = fu.open_id
  FROM feishu_user fu WHERE fu.user_id = pm.user_id;
ALTER TABLE production_member ALTER COLUMN open_id SET NOT NULL;
ALTER TABLE production_member DROP CONSTRAINT IF EXISTS production_member_pkey;
ALTER TABLE production_member ADD PRIMARY KEY (production_id, open_id);
ALTER TABLE production_member DROP CONSTRAINT IF EXISTS production_member_user_fk;
ALTER TABLE production_member DROP COLUMN IF EXISTS user_id;

-- ── Rev-2. feishu_user: drop user_id column (also drops feishu_user_user_id_fkey) ──

ALTER TABLE feishu_user DROP CONSTRAINT IF EXISTS feishu_user_user_id_key;
ALTER TABLE feishu_user DROP COLUMN IF EXISTS user_id;

-- ── Rev-1. Drop app_user ──────────────────────────────────────────────────────

DROP TABLE IF EXISTS app_user;

COMMIT;
