-- script_editor — canonical schema
-- Idempotent: safe to run on a fresh or existing database.
-- Run as: sudo -u postgres psql -d script_editor -f schema.sql
--
-- Table creation order follows FK dependency (parents before children).
-- Two circular FK pairs are resolved with deferred ALTER TABLE at the end:
--   • production.active_version_id  ↔  version.production_id
--   • tag_group.default_option_id   ↔  tag_option.group_id

-- ── Enums ─────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE block_type AS ENUM ('dialogue', 'stage', 'lyric');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE version_status AS ENUM ('editing', 'committed', 'frozen', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Users ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS feishu_user (
  open_id        TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  avatar_url     TEXT,
  email          TEXT,
  phone          TEXT,
  is_super_admin BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Productions ───────────────────────────────────────────────────────────────
-- active_version_id FK is added after version table (circular dependency).

CREATE TABLE IF NOT EXISTS production (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at       TIMESTAMPTZ,
  script_config     JSONB NOT NULL DEFAULT '{}',
  page_map          JSONB NOT NULL DEFAULT '{}',
  active_version_id TEXT,   -- FK to version(id) added below
  sort_order        INTEGER NOT NULL DEFAULT 0
);

-- ── Versions ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS version (
  id                TEXT PRIMARY KEY,
  production_id     TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name              TEXT NOT NULL DEFAULT '',
  description       TEXT NOT NULL DEFAULT '',
  tags              TEXT[] NOT NULL DEFAULT '{}',
  parent_version_id TEXT REFERENCES version(id) ON DELETE SET NULL,
  status            version_status NOT NULL DEFAULT 'editing',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS version_production_idx ON version(production_id, created_at);

-- Resolve circular FK: production → version
DO $$ BEGIN
  ALTER TABLE production ADD CONSTRAINT production_active_version_id_fkey
    FOREIGN KEY (active_version_id) REFERENCES version(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Members & permission overrides ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS production_member (
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  open_id       TEXT NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  roles         TEXT[] NOT NULL DEFAULT '{}',
  photo_url     TEXT,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (production_id, open_id)
);

CREATE TABLE IF NOT EXISTS production_member_permission (
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  open_id       TEXT NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  permission    TEXT NOT NULL,
  granted       BOOLEAN NOT NULL,
  PRIMARY KEY (production_id, open_id, permission)
);

-- ── Scenes ────────────────────────────────────────────────────────────────────
-- scene is an identity anchor only; all mutable scene data lives in scene_version.

CREATE TABLE IF NOT EXISTS scene (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE
);

-- scene_version.parent_id references scene(id), not scene_version — the
-- parent relationship is defined at the scene identity level, not per snapshot.
CREATE TABLE IF NOT EXISTS scene_version (
  scene_id          TEXT NOT NULL REFERENCES scene(id),
  version_id        TEXT NOT NULL REFERENCES version(id) ON DELETE CASCADE,
  num               TEXT NOT NULL DEFAULT '',
  name              TEXT NOT NULL DEFAULT '',
  sort_order        INTEGER NOT NULL DEFAULT 0,
  parent_id         TEXT REFERENCES scene(id) ON DELETE SET NULL,
  synopsis          TEXT,
  action_line       TEXT,
  music             TEXT,
  stage_notes       TEXT,
  expected_duration TEXT,
  PRIMARY KEY (scene_id, version_id)
);

CREATE INDEX IF NOT EXISTS scene_version_version_idx ON scene_version(version_id, sort_order);

-- ── Characters ────────────────────────────────────────────────────────────────
-- character is an identity anchor only; all mutable character data lives in character_version.

CREATE TABLE IF NOT EXISTS character (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS character_aggregate (
  aggregate_id TEXT NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  member_id    TEXT NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  PRIMARY KEY (aggregate_id, member_id)
);

CREATE TABLE IF NOT EXISTS character_version (
  character_id TEXT NOT NULL REFERENCES character(id),
  version_id   TEXT NOT NULL REFERENCES version(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT '',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_aggregate BOOLEAN NOT NULL DEFAULT false,
  gender       TEXT,
  biography    TEXT,
  role_type    TEXT,
  PRIMARY KEY (character_id, version_id)
);

CREATE INDEX IF NOT EXISTS character_version_version_idx ON character_version(version_id, sort_order);

-- ── Script blocks ─────────────────────────────────────────────────────────────
-- script rows are append-only snapshots; block_id is the stable logical identity
-- that persists across edits. sort_key is a fractional-index string.

CREATE TABLE IF NOT EXISTS script (
  id             TEXT PRIMARY KEY,
  production_id  TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  sort_key       TEXT NOT NULL,
  scene_id       TEXT REFERENCES scene(id) ON DELETE SET NULL,
  rehearsal_mark TEXT,
  type           block_type NOT NULL DEFAULT 'dialogue',
  content        TEXT NOT NULL DEFAULT '',
  stage_comment  TEXT,
  force_show_character_name BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  block_id       TEXT NOT NULL
);

ALTER TABLE script ADD COLUMN IF NOT EXISTS force_show_character_name BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE script ADD COLUMN IF NOT EXISTS stage_comment TEXT;

CREATE INDEX IF NOT EXISTS script_production_sort_idx ON script(production_id, sort_key);

CREATE TABLE IF NOT EXISTS script_character (
  script_id    TEXT NOT NULL REFERENCES script(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  annotation   TEXT,
  PRIMARY KEY (script_id, character_id)
);

-- script_version links a script snapshot (snapshot_id = script.id) to a version.
-- block_id is the logical block identity; sort_key is its position in that version.
CREATE TABLE IF NOT EXISTS script_version (
  snapshot_id TEXT NOT NULL REFERENCES script(id) ON DELETE CASCADE,
  version_id  TEXT NOT NULL REFERENCES version(id) ON DELETE CASCADE,
  block_id    TEXT NOT NULL,
  sort_key    TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, version_id)
);

CREATE INDEX IF NOT EXISTS script_version_version_idx ON script_version(version_id, sort_key);

-- ── Block tags ────────────────────────────────────────────────────────────────
-- tag_group and tag_option have a circular FK; resolved with deferred ALTER TABLE.

CREATE TABLE IF NOT EXISTS tag_group (
  id                          TEXT PRIMARY KEY,
  production_id               TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name                        TEXT NOT NULL,
  type                        TEXT NOT NULL CHECK (type IN ('exclusive', 'range')),
  range_min                   NUMERIC,
  range_max                   NUMERIC,
  range_step                  NUMERIC DEFAULT 1,
  range_default               NUMERIC,
  sort_order                  INTEGER NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  default_option_id           TEXT,   -- FK to tag_option(id) added below
  lyric_split_after_option_id TEXT    -- FK to tag_option(id) added below
);

CREATE TABLE IF NOT EXISTS tag_option (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES tag_group(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#a1a1aa',
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Resolve circular FKs: tag_group → tag_option
DO $$ BEGIN
  ALTER TABLE tag_group ADD CONSTRAINT tag_group_default_option_id_fkey
    FOREIGN KEY (default_option_id) REFERENCES tag_option(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE tag_group ADD CONSTRAINT tag_group_lyric_split_after_option_id_fkey
    FOREIGN KEY (lyric_split_after_option_id) REFERENCES tag_option(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS block_tag (
  -- block_id stores the logical block_id (script.block_id), NOT a snapshot_id.
  -- No FK: tags are keyed by stable logical identity; delete-cascade is handled
  -- at the application layer when blocks are explicitly removed.
  block_id   TEXT NOT NULL,
  group_id   TEXT NOT NULL REFERENCES tag_group(id) ON DELETE CASCADE,
  option_id  TEXT REFERENCES tag_option(id) ON DELETE SET NULL,
  value      NUMERIC,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (block_id, group_id)
);

CREATE INDEX IF NOT EXISTS block_tag_block_idx ON block_tag(block_id);
CREATE INDEX IF NOT EXISTS block_tag_group_idx ON block_tag(group_id);

-- ── Comments ──────────────────────────────────────────────────────────────────

-- Legacy per-block comments (used by early versions of the script editor).
CREATE TABLE IF NOT EXISTS block_comment (
  id            TEXT PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  block_id      TEXT NOT NULL,
  open_id       TEXT NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  author_name   TEXT NOT NULL,
  content       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS block_comment_production_id_idx ON block_comment(production_id);
CREATE INDEX IF NOT EXISTS block_comment_production_id_block_id_idx ON block_comment(production_id, block_id);

-- Unified comment system: threaded, multi-context (block, event, report, etc.).
CREATE TABLE IF NOT EXISTS comment (
  id            TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  context_type  TEXT NOT NULL DEFAULT 'block',
  context_id    TEXT NOT NULL,
  parent_id     TEXT REFERENCES comment(id) ON DELETE CASCADE,
  open_id       TEXT NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  author_name   TEXT NOT NULL,
  body          TEXT NOT NULL,
  mentions      JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS comment_production_idx ON comment(production_id, created_at DESC);
CREATE INDEX IF NOT EXISTS comment_context_idx ON comment(context_type, context_id);
CREATE INDEX IF NOT EXISTS comment_mentions_idx ON comment USING GIN (mentions);

-- ── Cue lists ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cue_list (
  id                 TEXT PRIMARY KEY,
  production_id      TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  abbr               TEXT,
  notes              TEXT NOT NULL DEFAULT '',
  template           TEXT,
  default_edit_roles TEXT[] NOT NULL DEFAULT '{}',
  created_by         TEXT NOT NULL REFERENCES feishu_user(open_id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- abbr must be unique per production (NULLs are treated as distinct).
CREATE UNIQUE INDEX IF NOT EXISTS cue_list_abbr_production_unique ON cue_list(production_id, abbr);
CREATE INDEX IF NOT EXISTS cue_list_production_idx ON cue_list(production_id, created_at);

CREATE TABLE IF NOT EXISTS cue_list_permission (
  cue_list_id TEXT NOT NULL REFERENCES cue_list(id) ON DELETE CASCADE,
  open_id     TEXT NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  can_edit    BOOLEAN NOT NULL,
  PRIMARY KEY (cue_list_id, open_id)
);

-- ── Cues ──────────────────────────────────────────────────────────────────────
-- Each row is a revision of a cue. cue_id is the stable logical identity across
-- edits. start/end_snapshot_id record which script snapshot anchors were set
-- against, enabling drift detection when the script changes.
--
-- Anchor kinds:
--   'block' — precise character offset within a block (start_offset = char index)
--   'gap'   — the visual whitespace after a block (start_offset = NULL)
-- Point cue: start == end (both kind + snapshot + offset identical).

CREATE TABLE IF NOT EXISTS cue (
  id                TEXT PRIMARY KEY,
  cue_list_id       TEXT NOT NULL REFERENCES cue_list(id) ON DELETE CASCADE,
  number            TEXT NOT NULL,
  name              TEXT NOT NULL DEFAULT '',
  content           TEXT NOT NULL DEFAULT '',
  start_kind        TEXT NOT NULL CHECK (start_kind IN ('block', 'gap')),
  start_offset      INTEGER,          -- NULL when start_kind = 'gap'
  end_kind          TEXT NOT NULL CHECK (end_kind IN ('block', 'gap')),
  end_offset        INTEGER,          -- NULL when end_kind = 'gap'
  warning           BOOLEAN NOT NULL DEFAULT false,
  cue_id            TEXT,             -- logical cue identity (no FK)
  start_snapshot_id TEXT,             -- script.id snapshot when anchor was set (no FK)
  end_snapshot_id   TEXT,             -- script.id snapshot when anchor was set (no FK)
  UNIQUE (cue_list_id, number)
);

CREATE INDEX IF NOT EXISTS cue_list_idx ON cue(cue_list_id);

-- cue_version links a cue revision to a script version for version-aware cue sheets.
-- cue_id here is the logical cue identity (denormalized, no FK).
CREATE TABLE IF NOT EXISTS cue_version (
  revision_id TEXT NOT NULL REFERENCES cue(id) ON DELETE CASCADE,
  version_id  TEXT NOT NULL REFERENCES version(id) ON DELETE CASCADE,
  cue_id      TEXT NOT NULL,
  PRIMARY KEY (revision_id, version_id)
);

CREATE INDEX IF NOT EXISTS cue_version_version_idx ON cue_version(version_id);

-- ── Events & schedule ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS production_event (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  event_type    TEXT NOT NULL DEFAULT 'custom',
  location      TEXT NOT NULL DEFAULT '',
  start_time    TIMESTAMPTZ,
  end_time      TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'draft',
  description   TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL REFERENCES feishu_user(open_id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  chat_id       TEXT,
  version_id    TEXT REFERENCES version(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS production_event_production_idx ON production_event(production_id, start_time);

-- Global departments for a production (shared across all events).
CREATE TABLE IF NOT EXISTS event_department (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'dept',
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  chat_id       TEXT
);

CREATE INDEX IF NOT EXISTS event_department_production_idx ON event_department(production_id, display_order);

CREATE TABLE IF NOT EXISTS event_department_member (
  department_id TEXT NOT NULL REFERENCES event_department(id) ON DELETE CASCADE,
  open_id       TEXT NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  is_poc        BOOLEAN NOT NULL DEFAULT false,
  is_member     BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (department_id, open_id)
);

CREATE TABLE IF NOT EXISTS event_stage_manager (
  event_id TEXT NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  open_id  TEXT NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  PRIMARY KEY (event_id, open_id)
);

CREATE INDEX IF NOT EXISTS event_stage_manager_event_idx ON event_stage_manager(event_id);

CREATE TABLE IF NOT EXISTS event_participant (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  open_id       TEXT NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  department_id TEXT REFERENCES event_department(id) ON DELETE SET NULL,
  role          TEXT NOT NULL DEFAULT 'participant',
  UNIQUE (event_id, open_id)
);

CREATE INDEX IF NOT EXISTS event_participant_event_idx ON event_participant(event_id);

CREATE TABLE IF NOT EXISTS event_schedule_item (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  item_type       TEXT NOT NULL DEFAULT 'custom',
  start_time      TIMESTAMPTZ,
  end_time        TIMESTAMPTZ,
  location        TEXT NOT NULL DEFAULT '',
  order_index     INTEGER NOT NULL DEFAULT 0,
  target_scene_id TEXT REFERENCES scene(id) ON DELETE SET NULL,
  target_block_id TEXT,
  notes           TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS event_schedule_item_event_idx ON event_schedule_item(event_id, order_index);

CREATE TABLE IF NOT EXISTS schedule_item_department (
  item_id TEXT NOT NULL REFERENCES event_schedule_item(id) ON DELETE CASCADE,
  dept_id TEXT NOT NULL REFERENCES event_department(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, dept_id)
);

CREATE TABLE IF NOT EXISTS schedule_item_participant (
  item_id TEXT NOT NULL REFERENCES event_schedule_item(id) ON DELETE CASCADE,
  open_id TEXT NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  PRIMARY KEY (item_id, open_id)
);

CREATE INDEX IF NOT EXISTS schedule_item_participant_item_idx ON schedule_item_participant(item_id);

CREATE TABLE IF NOT EXISTS event_call_time (
  id               TEXT PRIMARY KEY,
  event_id         TEXT NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  open_id          TEXT NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  department_id    TEXT REFERENCES event_department(id) ON DELETE SET NULL,
  call_at          TIMESTAMPTZ NOT NULL,
  schedule_item_id TEXT REFERENCES event_schedule_item(id) ON DELETE SET NULL,
  notes            TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS event_call_time_event_idx ON event_call_time(event_id);

CREATE TABLE IF NOT EXISTS event_tech_req (
  id               TEXT PRIMARY KEY,
  event_id         TEXT NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  schedule_item_id TEXT REFERENCES event_schedule_item(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  preset_minutes   INTEGER,
  department_id    TEXT REFERENCES event_department(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  chat_id          TEXT
);

CREATE INDEX IF NOT EXISTS event_tech_req_event_idx ON event_tech_req(event_id);

CREATE TABLE IF NOT EXISTS event_tech_req_item (
  req_id  TEXT NOT NULL REFERENCES event_tech_req(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES event_schedule_item(id) ON DELETE CASCADE,
  PRIMARY KEY (req_id, item_id)
);

CREATE INDEX IF NOT EXISTS event_tech_req_item_req_idx ON event_tech_req_item(req_id);

CREATE TABLE IF NOT EXISTS event_tech_assignee (
  req_id  TEXT NOT NULL REFERENCES event_tech_req(id) ON DELETE CASCADE,
  open_id TEXT NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  PRIMARY KEY (req_id, open_id)
);

-- ── Reports ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_report (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  report_type  TEXT NOT NULL DEFAULT 'rehearsal',
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL REFERENCES feishu_user(open_id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  mentions     JSONB NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS event_report_event_idx ON event_report(event_id);

CREATE TABLE IF NOT EXISTS event_report_note (
  id             TEXT PRIMARY KEY,
  report_id      TEXT NOT NULL REFERENCES event_report(id) ON DELETE CASCADE,
  department_id  TEXT NOT NULL REFERENCES event_department(id) ON DELETE CASCADE,
  content        TEXT NOT NULL,
  author_open_id TEXT NOT NULL REFERENCES feishu_user(open_id),
  author_name    TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  mentions       JSONB NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS event_report_note_report_idx ON event_report_note(report_id);

CREATE TABLE IF NOT EXISTS event_report_read (
  report_id TEXT NOT NULL REFERENCES event_report(id) ON DELETE CASCADE,
  open_id   TEXT NOT NULL,
  read_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, open_id)
);

-- open_id and parent_id have no FK — replies may reference either a report or a note.
CREATE TABLE IF NOT EXISTS event_report_reply (
  id          TEXT PRIMARY KEY,
  report_id   TEXT NOT NULL REFERENCES event_report(id) ON DELETE CASCADE,
  parent_type TEXT NOT NULL,
  parent_id   TEXT NOT NULL,
  open_id     TEXT NOT NULL,
  author_name TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  mentions    JSONB NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_event_report_reply_report_id ON event_report_reply(report_id);

-- ── Notifications ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_subscription (
  open_id           TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  enabled           BOOLEAN NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (open_id, notification_type)
);

-- ── Bot testers ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bot_testers (
  open_id  TEXT PRIMARY KEY,
  name     TEXT NOT NULL DEFAULT '',
  added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Assets ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS asset (
  id               TEXT PRIMARY KEY,
  production_id    TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  uploader_open_id TEXT NOT NULL REFERENCES feishu_user(open_id),
  asset_type       TEXT NOT NULL DEFAULT 'reference',
  file_name        TEXT NOT NULL,
  mime_type        TEXT,
  is_universal     BOOLEAN NOT NULL DEFAULT true,
  storage_type     TEXT NOT NULL DEFAULT 'r2',
  feishu_url       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  name             TEXT
);

CREATE INDEX IF NOT EXISTS asset_production_idx ON asset(production_id, created_at DESC);
CREATE INDEX IF NOT EXISTS asset_uploader_idx ON asset(uploader_open_id);

CREATE TABLE IF NOT EXISTS asset_file (
  id               TEXT PRIMARY KEY,
  asset_id         TEXT NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  r2_key           TEXT,
  thumbnail_r2_key TEXT,
  file_size        BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS asset_file_asset_idx ON asset_file(asset_id);

CREATE TABLE IF NOT EXISTS asset_mount (
  id               TEXT PRIMARY KEY,
  asset_id         TEXT NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  production_id    TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  mount_type       TEXT NOT NULL,
  mount_id         TEXT NOT NULL,
  mount_aux_id     TEXT,
  folder_path      TEXT,
  mount_mode       TEXT,
  version_resolved BOOLEAN,
  created_by       TEXT NOT NULL REFERENCES feishu_user(open_id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS asset_mount_production_idx ON asset_mount(production_id);
CREATE INDEX IF NOT EXISTS asset_mount_point_idx ON asset_mount(mount_type, mount_id);
CREATE INDEX IF NOT EXISTS asset_mount_asset_idx ON asset_mount(asset_id);

-- Links an asset (with a specific file version) to a script version.
CREATE TABLE IF NOT EXISTS asset_version_rel (
  asset_id      TEXT NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  version_id    TEXT NOT NULL REFERENCES version(id) ON DELETE CASCADE,
  asset_file_id TEXT NOT NULL REFERENCES asset_file(id) ON DELETE CASCADE,
  PRIMARY KEY (asset_id, version_id)
);

CREATE INDEX IF NOT EXISTS asset_version_rel_version_idx ON asset_version_rel(version_id);
CREATE INDEX IF NOT EXISTS asset_version_rel_file_idx ON asset_version_rel(asset_file_id);
