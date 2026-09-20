-- Introduce an internal app_user table and replace all feishu_user(open_id)
-- foreign keys with app_user(id) UUID references.
--
-- feishu_user is retained as the Feishu identity bridge:
--   feishu_user.user_id → app_user.id  (the new canonical user PK)
--   feishu_user.open_id stays as the Feishu-specific identifier used only
--   by Feishu API calls (sendCard, bot DMs, webhook matching, bot_testers).
--
-- bot_testers is intentionally excluded: it is a Feishu-layer control table
-- whose open_id values come directly from Feishu webhook events.
--
-- JSONB mentions fields (event_report.mentions, comment.mentions, etc.) are
-- also migrated: { openId } references are replaced with { userId } UUIDs
-- so that the frontend and notification layer use internal IDs consistently.
--
-- Run with: psql -v ON_ERROR_STOP=1 -d <db> -f migrate-internal-user-id.sql

BEGIN;

-- ── 1. Create app_user table ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_user (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 2. Add user_id to feishu_user + backfill ─────────────────────────────────

ALTER TABLE feishu_user ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES app_user(id) ON DELETE CASCADE;

DO $$
DECLARE r RECORD;
        new_id UUID;
BEGIN
  FOR r IN SELECT open_id FROM feishu_user WHERE user_id IS NULL LOOP
    new_id := gen_random_uuid();
    INSERT INTO app_user (id) VALUES (new_id);
    UPDATE feishu_user SET user_id = new_id WHERE open_id = r.open_id;
  END LOOP;
END $$;

ALTER TABLE feishu_user ALTER COLUMN user_id SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE feishu_user ADD CONSTRAINT feishu_user_user_id_key UNIQUE (user_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

-- ── 3. production_member: (production_id, open_id) PK → (production_id, user_id) ──

ALTER TABLE production_member ADD COLUMN IF NOT EXISTS user_id UUID;
UPDATE production_member pm
  SET user_id = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = pm.open_id AND pm.user_id IS NULL;
ALTER TABLE production_member ALTER COLUMN user_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE production_member ADD CONSTRAINT production_member_user_fk
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE production_member DROP CONSTRAINT IF EXISTS production_member_pkey;
ALTER TABLE production_member ADD PRIMARY KEY (production_id, user_id);
ALTER TABLE production_member DROP COLUMN IF EXISTS open_id;

-- ── 4. production_member_permission: PK includes open_id ────────────────────

ALTER TABLE production_member_permission ADD COLUMN IF NOT EXISTS user_id UUID;
UPDATE production_member_permission pmp
  SET user_id = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = pmp.open_id AND pmp.user_id IS NULL;
ALTER TABLE production_member_permission ALTER COLUMN user_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE production_member_permission ADD CONSTRAINT production_member_permission_user_fk
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE production_member_permission DROP CONSTRAINT IF EXISTS production_member_permission_pkey;
ALTER TABLE production_member_permission ADD PRIMARY KEY (production_id, user_id, permission);
ALTER TABLE production_member_permission DROP COLUMN IF EXISTS open_id;

-- ── 5. comment: open_id → user_id ────────────────────────────────────────────

ALTER TABLE comment ADD COLUMN IF NOT EXISTS user_id UUID;
UPDATE comment c
  SET user_id = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = c.open_id AND c.user_id IS NULL;
ALTER TABLE comment ALTER COLUMN user_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE comment ADD CONSTRAINT comment_user_fk
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE comment DROP COLUMN IF EXISTS open_id;

-- ── 6. cue_list: created_by (TEXT open_id) → UUID user_id ───────────────────

ALTER TABLE cue_list ADD COLUMN IF NOT EXISTS created_by_uid UUID;
UPDATE cue_list cl
  SET created_by_uid = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = cl.created_by AND cl.created_by_uid IS NULL;
ALTER TABLE cue_list ALTER COLUMN created_by_uid SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE cue_list ADD CONSTRAINT cue_list_created_by_fk
    FOREIGN KEY (created_by_uid) REFERENCES app_user(id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE cue_list DROP COLUMN IF EXISTS created_by;
ALTER TABLE cue_list RENAME COLUMN created_by_uid TO created_by;

-- ── 7. cue_list_permission: PK (cue_list_id, open_id) ───────────────────────

ALTER TABLE cue_list_permission ADD COLUMN IF NOT EXISTS user_id UUID;
UPDATE cue_list_permission clp
  SET user_id = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = clp.open_id AND clp.user_id IS NULL;
ALTER TABLE cue_list_permission ALTER COLUMN user_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE cue_list_permission ADD CONSTRAINT cue_list_permission_user_fk
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE cue_list_permission DROP CONSTRAINT IF EXISTS cue_list_permission_pkey;
ALTER TABLE cue_list_permission ADD PRIMARY KEY (cue_list_id, user_id);
ALTER TABLE cue_list_permission DROP COLUMN IF EXISTS open_id;

-- ── 8. production_event: created_by TEXT → UUID ──────────────────────────────

ALTER TABLE production_event ADD COLUMN IF NOT EXISTS created_by_uid UUID;
UPDATE production_event pe
  SET created_by_uid = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = pe.created_by AND pe.created_by_uid IS NULL;
ALTER TABLE production_event ALTER COLUMN created_by_uid SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE production_event ADD CONSTRAINT production_event_created_by_fk
    FOREIGN KEY (created_by_uid) REFERENCES app_user(id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE production_event DROP COLUMN IF EXISTS created_by;
ALTER TABLE production_event RENAME COLUMN created_by_uid TO created_by;

-- ── 9. event_department_member: PK (department_id, open_id) ─────────────────

ALTER TABLE event_department_member ADD COLUMN IF NOT EXISTS user_id UUID;
UPDATE event_department_member edm
  SET user_id = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = edm.open_id AND edm.user_id IS NULL;
ALTER TABLE event_department_member ALTER COLUMN user_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE event_department_member ADD CONSTRAINT event_department_member_user_fk
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE event_department_member DROP CONSTRAINT IF EXISTS event_department_member_pkey;
ALTER TABLE event_department_member ADD PRIMARY KEY (department_id, user_id);
ALTER TABLE event_department_member DROP COLUMN IF EXISTS open_id;

-- ── 10. event_stage_manager: PK (event_id, open_id), keep name ──────────────

ALTER TABLE event_stage_manager ADD COLUMN IF NOT EXISTS user_id UUID;
UPDATE event_stage_manager esm
  SET user_id = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = esm.open_id AND esm.user_id IS NULL;
ALTER TABLE event_stage_manager ALTER COLUMN user_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE event_stage_manager ADD CONSTRAINT event_stage_manager_user_fk
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE event_stage_manager DROP CONSTRAINT IF EXISTS event_stage_manager_pkey;
ALTER TABLE event_stage_manager ADD PRIMARY KEY (event_id, user_id);
ALTER TABLE event_stage_manager DROP COLUMN IF EXISTS open_id;

-- ── 11. event_participant: UNIQUE (event_id, open_id), keep name ─────────────

ALTER TABLE event_participant ADD COLUMN IF NOT EXISTS user_id UUID;
UPDATE event_participant ep
  SET user_id = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = ep.open_id AND ep.user_id IS NULL;
ALTER TABLE event_participant ALTER COLUMN user_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE event_participant ADD CONSTRAINT event_participant_user_fk
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE event_participant DROP CONSTRAINT IF EXISTS event_participant_event_id_open_id_key;
DO $$ BEGIN
  ALTER TABLE event_participant ADD CONSTRAINT event_participant_event_user_unique UNIQUE (event_id, user_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE event_participant DROP COLUMN IF EXISTS open_id;

-- ── 12. schedule_item_participant: PK (item_id, open_id), keep name ──────────

ALTER TABLE schedule_item_participant ADD COLUMN IF NOT EXISTS user_id UUID;
UPDATE schedule_item_participant sip
  SET user_id = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = sip.open_id AND sip.user_id IS NULL;
ALTER TABLE schedule_item_participant ALTER COLUMN user_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE schedule_item_participant ADD CONSTRAINT schedule_item_participant_user_fk
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE schedule_item_participant DROP CONSTRAINT IF EXISTS schedule_item_participant_pkey;
ALTER TABLE schedule_item_participant ADD PRIMARY KEY (item_id, user_id);
ALTER TABLE schedule_item_participant DROP COLUMN IF EXISTS open_id;

-- ── 13. event_call_time: open_id → user_id, keep name ───────────────────────

ALTER TABLE event_call_time ADD COLUMN IF NOT EXISTS user_id UUID;
UPDATE event_call_time ect
  SET user_id = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = ect.open_id AND ect.user_id IS NULL;
ALTER TABLE event_call_time ALTER COLUMN user_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE event_call_time ADD CONSTRAINT event_call_time_user_fk
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE event_call_time DROP COLUMN IF EXISTS open_id;

-- ── 14. event_tech_assignee: PK (req_id, open_id), keep name ────────────────

ALTER TABLE event_tech_assignee ADD COLUMN IF NOT EXISTS user_id UUID;
UPDATE event_tech_assignee eta
  SET user_id = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = eta.open_id AND eta.user_id IS NULL;
ALTER TABLE event_tech_assignee ALTER COLUMN user_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE event_tech_assignee ADD CONSTRAINT event_tech_assignee_user_fk
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE event_tech_assignee DROP CONSTRAINT IF EXISTS event_tech_assignee_pkey;
ALTER TABLE event_tech_assignee ADD PRIMARY KEY (req_id, user_id);
ALTER TABLE event_tech_assignee DROP COLUMN IF EXISTS open_id;

-- ── 15. event_report: created_by TEXT → UUID ─────────────────────────────────

ALTER TABLE event_report ADD COLUMN IF NOT EXISTS created_by_uid UUID;
UPDATE event_report er
  SET created_by_uid = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = er.created_by AND er.created_by_uid IS NULL;
ALTER TABLE event_report ALTER COLUMN created_by_uid SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE event_report ADD CONSTRAINT event_report_created_by_fk
    FOREIGN KEY (created_by_uid) REFERENCES app_user(id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE event_report DROP COLUMN IF EXISTS created_by;
ALTER TABLE event_report RENAME COLUMN created_by_uid TO created_by;

-- ── 16. event_report_note: author_open_id → author_user_id ──────────────────

ALTER TABLE event_report_note ADD COLUMN IF NOT EXISTS author_user_id UUID;
UPDATE event_report_note ern
  SET author_user_id = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = ern.author_open_id AND ern.author_user_id IS NULL;
ALTER TABLE event_report_note ALTER COLUMN author_user_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE event_report_note ADD CONSTRAINT event_report_note_author_fk
    FOREIGN KEY (author_user_id) REFERENCES app_user(id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE event_report_note DROP COLUMN IF EXISTS author_open_id;

-- ── 17. event_report_read: no FK — backfill via JOIN, drop orphans ───────────

ALTER TABLE event_report_read ADD COLUMN IF NOT EXISTS user_id UUID;
UPDATE event_report_read err
  SET user_id = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = err.open_id AND err.user_id IS NULL;
DELETE FROM event_report_read WHERE user_id IS NULL;
ALTER TABLE event_report_read ALTER COLUMN user_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE event_report_read ADD CONSTRAINT event_report_read_user_fk
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE event_report_read DROP CONSTRAINT IF EXISTS event_report_read_pkey;
ALTER TABLE event_report_read ADD PRIMARY KEY (report_id, user_id);
ALTER TABLE event_report_read DROP COLUMN IF EXISTS open_id;

-- ── 18. event_report_reply: no FK — backfill via JOIN, drop orphans ──────────

ALTER TABLE event_report_reply ADD COLUMN IF NOT EXISTS user_id UUID;
UPDATE event_report_reply err
  SET user_id = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = err.open_id AND err.user_id IS NULL;
DELETE FROM event_report_reply WHERE user_id IS NULL;
ALTER TABLE event_report_reply ALTER COLUMN user_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE event_report_reply ADD CONSTRAINT event_report_reply_user_fk
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE event_report_reply DROP COLUMN IF EXISTS open_id;

-- ── 19. notification_subscription: PK (open_id, notification_type) ───────────
--   no existing FK — backfill via JOIN, drop orphans

ALTER TABLE notification_subscription ADD COLUMN IF NOT EXISTS user_id UUID;
UPDATE notification_subscription ns
  SET user_id = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = ns.open_id AND ns.user_id IS NULL;
DELETE FROM notification_subscription WHERE user_id IS NULL;
ALTER TABLE notification_subscription ALTER COLUMN user_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE notification_subscription ADD CONSTRAINT notification_subscription_user_fk
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE notification_subscription DROP CONSTRAINT IF EXISTS notification_subscription_pkey;
ALTER TABLE notification_subscription ADD PRIMARY KEY (user_id, notification_type);
ALTER TABLE notification_subscription DROP COLUMN IF EXISTS open_id;

-- ── 20. asset: uploader_open_id → uploader_user_id ───────────────────────────

ALTER TABLE asset ADD COLUMN IF NOT EXISTS uploader_user_id UUID;
UPDATE asset a
  SET uploader_user_id = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = a.uploader_open_id AND a.uploader_user_id IS NULL;
ALTER TABLE asset ALTER COLUMN uploader_user_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE asset ADD CONSTRAINT asset_uploader_user_fk
    FOREIGN KEY (uploader_user_id) REFERENCES app_user(id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
DROP INDEX IF EXISTS asset_uploader_idx;
CREATE INDEX IF NOT EXISTS asset_uploader_idx ON asset(uploader_user_id);
ALTER TABLE asset DROP COLUMN IF EXISTS uploader_open_id;

-- ── 21. asset_mount: created_by TEXT → UUID ──────────────────────────────────

ALTER TABLE asset_mount ADD COLUMN IF NOT EXISTS created_by_uid UUID;
UPDATE asset_mount am
  SET created_by_uid = fu.user_id
  FROM feishu_user fu
  WHERE fu.open_id = am.created_by AND am.created_by_uid IS NULL;
ALTER TABLE asset_mount ALTER COLUMN created_by_uid SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE asset_mount ADD CONSTRAINT asset_mount_created_by_fk
    FOREIGN KEY (created_by_uid) REFERENCES app_user(id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
ALTER TABLE asset_mount DROP COLUMN IF EXISTS created_by;
ALTER TABLE asset_mount RENAME COLUMN created_by_uid TO created_by;

-- ── 22. Migrate JSONB mentions: { openId } → { userId } ──────────────────────
-- Tables: comment, event_report, event_report_note, event_report_reply
-- For each element in the JSONB array that has an openId field, replace the
-- openId key+value with userId (UUID) using the feishu_user bridge table.
-- Lookup order: exact open_id match first; if the stored value is a display
-- name (data quality bug), fall back to a unique name match. Elements that
-- cannot be resolved via either path are kept as-is.

UPDATE comment c
SET mentions = (
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN t.elem ? 'openId' AND fu.user_id IS NOT NULL
          THEN (t.elem - 'openId') || jsonb_build_object('userId', fu.user_id::text)
        ELSE t.elem
      END
      ORDER BY t.ord
    ) FILTER (WHERE NOT (t.elem ? 'openId') OR fu.user_id IS NOT NULL),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(c.mentions) WITH ORDINALITY AS t(elem, ord)
  LEFT JOIN LATERAL (
    SELECT user_id FROM feishu_user WHERE open_id = t.elem->>'openId'
    UNION ALL
    SELECT user_id FROM feishu_user
    WHERE name = t.elem->>'openId'
      AND NOT EXISTS (SELECT 1 FROM feishu_user WHERE open_id = t.elem->>'openId')
      AND 1 = (SELECT COUNT(*) FROM feishu_user WHERE name = t.elem->>'openId')
    LIMIT 1
  ) fu ON TRUE
)
WHERE jsonb_array_length(c.mentions) > 0;

UPDATE event_report r
SET mentions = (
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN t.elem ? 'openId' AND fu.user_id IS NOT NULL
          THEN (t.elem - 'openId') || jsonb_build_object('userId', fu.user_id::text)
        ELSE t.elem
      END
      ORDER BY t.ord
    ) FILTER (WHERE NOT (t.elem ? 'openId') OR fu.user_id IS NOT NULL),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(r.mentions) WITH ORDINALITY AS t(elem, ord)
  LEFT JOIN LATERAL (
    SELECT user_id FROM feishu_user WHERE open_id = t.elem->>'openId'
    UNION ALL
    SELECT user_id FROM feishu_user
    WHERE name = t.elem->>'openId'
      AND NOT EXISTS (SELECT 1 FROM feishu_user WHERE open_id = t.elem->>'openId')
      AND 1 = (SELECT COUNT(*) FROM feishu_user WHERE name = t.elem->>'openId')
    LIMIT 1
  ) fu ON TRUE
)
WHERE jsonb_array_length(r.mentions) > 0;

UPDATE event_report_note n
SET mentions = (
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN t.elem ? 'openId' AND fu.user_id IS NOT NULL
          THEN (t.elem - 'openId') || jsonb_build_object('userId', fu.user_id::text)
        ELSE t.elem
      END
      ORDER BY t.ord
    ) FILTER (WHERE NOT (t.elem ? 'openId') OR fu.user_id IS NOT NULL),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(n.mentions) WITH ORDINALITY AS t(elem, ord)
  LEFT JOIN LATERAL (
    SELECT user_id FROM feishu_user WHERE open_id = t.elem->>'openId'
    UNION ALL
    SELECT user_id FROM feishu_user
    WHERE name = t.elem->>'openId'
      AND NOT EXISTS (SELECT 1 FROM feishu_user WHERE open_id = t.elem->>'openId')
      AND 1 = (SELECT COUNT(*) FROM feishu_user WHERE name = t.elem->>'openId')
    LIMIT 1
  ) fu ON TRUE
)
WHERE jsonb_array_length(n.mentions) > 0;

UPDATE event_report_reply rp
SET mentions = (
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN t.elem ? 'openId' AND fu.user_id IS NOT NULL
          THEN (t.elem - 'openId') || jsonb_build_object('userId', fu.user_id::text)
        ELSE t.elem
      END
      ORDER BY t.ord
    ) FILTER (WHERE NOT (t.elem ? 'openId') OR fu.user_id IS NOT NULL),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(rp.mentions) WITH ORDINALITY AS t(elem, ord)
  LEFT JOIN LATERAL (
    SELECT user_id FROM feishu_user WHERE open_id = t.elem->>'openId'
    UNION ALL
    SELECT user_id FROM feishu_user
    WHERE name = t.elem->>'openId'
      AND NOT EXISTS (SELECT 1 FROM feishu_user WHERE open_id = t.elem->>'openId')
      AND 1 = (SELECT COUNT(*) FROM feishu_user WHERE name = t.elem->>'openId')
    LIMIT 1
  ) fu ON TRUE
)
WHERE jsonb_array_length(rp.mentions) > 0;

COMMIT;
