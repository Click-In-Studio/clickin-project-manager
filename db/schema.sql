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

ALTER TYPE block_type ADD VALUE IF NOT EXISTS 'chapter_marker';
ALTER TYPE block_type ADD VALUE IF NOT EXISTS 'scene_marker';
ALTER TYPE block_type ADD VALUE IF NOT EXISTS 'rehearsal_marker';

DO $$ BEGIN
  CREATE TYPE version_status AS ENUM ('editing', 'committed', 'frozen', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Users ─────────────────────────────────────────────────────────────────────
-- app_user is the internal identity anchor (UUID PK).
-- feishu_user retains open_id as PK for Feishu-layer calls (bot, webhook, DMs).
-- All application tables reference app_user.id, not feishu_user.open_id.

CREATE TABLE IF NOT EXISTS app_user (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feishu_user (
  open_id        TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  avatar_url     TEXT,
  email          TEXT,
  phone          TEXT,
  is_super_admin BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id        UUID NOT NULL UNIQUE REFERENCES app_user(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_profile (
  user_id            UUID PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  display_name       TEXT,
  bio                TEXT,
  avatar_url         TEXT,
  phone              TEXT,
  preferred_platform TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_otp (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  code       TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS email_otp_lookup ON email_otp(email, code) WHERE used_at IS NULL;

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
  sort_order        INTEGER NOT NULL DEFAULT 0,
  description       TEXT NOT NULL DEFAULT '',
  avatar_url        TEXT,
  type              TEXT,
  type_label        TEXT,
  language          TEXT,
  owner_id          UUID REFERENCES app_user(id)
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
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  script_config     JSONB NOT NULL DEFAULT '{}',
  marker_structure_revision BIGINT NOT NULL DEFAULT 0
);

ALTER TABLE version ADD COLUMN IF NOT EXISTS marker_structure_revision BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS version_production_idx ON version(production_id, created_at);

-- Resolve circular FK: production → version
DO $$ BEGIN
  ALTER TABLE production ADD CONSTRAINT production_active_version_id_fkey
    FOREIGN KEY (active_version_id) REFERENCES version(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Atomic permission roles ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS production_role (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_deprecated BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (production_id, name)
);

CREATE INDEX IF NOT EXISTS production_role_production_idx ON production_role(production_id);

CREATE TABLE IF NOT EXISTS production_role_permission (
  role_id        TEXT NOT NULL REFERENCES production_role(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_key)
);

CREATE INDEX IF NOT EXISTS production_role_permission_role_idx ON production_role_permission(role_id);

-- production_role_cue_type dropped in Phase 4 (migrate-role-cue-type-to-dept.sql)
-- cue type authorization now managed via production_dept.allowed_cue_types

-- ── Members & permission overrides ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS production_member (
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  roles         TEXT[] NOT NULL DEFAULT '{}',
  photo_url     TEXT,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (production_id, user_id)
);

CREATE TABLE IF NOT EXISTS production_member_permission (
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  permission    TEXT NOT NULL,
  granted       BOOLEAN NOT NULL,
  PRIMARY KEY (production_id, user_id, permission)
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
  owner_marker_id TEXT,
  type           block_type NOT NULL DEFAULT 'dialogue',
  content        TEXT NOT NULL DEFAULT '',
  stage_comment  TEXT,
  marker_meta    JSONB NOT NULL DEFAULT '{}',
  force_show_character_name BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  block_id       TEXT NOT NULL
);

ALTER TABLE script ADD COLUMN IF NOT EXISTS force_show_character_name BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE script ADD COLUMN IF NOT EXISTS stage_comment TEXT;
ALTER TABLE script ADD COLUMN IF NOT EXISTS marker_meta JSONB NOT NULL DEFAULT '{}';
ALTER TABLE script ADD COLUMN IF NOT EXISTS owner_marker_id TEXT;

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
CREATE UNIQUE INDEX IF NOT EXISTS script_version_version_block_uidx ON script_version(version_id, block_id);

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

-- Unified comment system: threaded, multi-context (block, event, report, etc.).
CREATE TABLE IF NOT EXISTS comment (
  id            TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  context_type  TEXT NOT NULL DEFAULT 'block',
  context_id    TEXT NOT NULL,
  parent_id     TEXT REFERENCES comment(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
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
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  abbr          TEXT,
  notes         TEXT NOT NULL DEFAULT '',
  template      TEXT,
  created_by    UUID NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- abbr must be unique per production (NULLs are treated as distinct).
CREATE UNIQUE INDEX IF NOT EXISTS cue_list_abbr_production_unique ON cue_list(production_id, abbr);
CREATE INDEX IF NOT EXISTS cue_list_production_idx ON cue_list(production_id, created_at);

-- Per-user access override: can_edit=true grants, can_edit=false denies,
-- cue_list_permission and cue_list_role dropped in Phase 4 (migrate-cue-list-to-resource-grant.sql)
-- Access is now managed via resource_grant (resource_type='cue_list').

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
  end_snapshot_id   TEXT             -- script.id snapshot when anchor was set (no FK)
  -- no UNIQUE (cue_list_id, number): cue is a revision table; the same logical
  -- cue number can have multiple rows across different versions
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
  created_by    UUID NOT NULL REFERENCES app_user(id),
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
  user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  is_poc        BOOLEAN NOT NULL DEFAULT false,
  is_member     BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (department_id, user_id)
);

CREATE TABLE IF NOT EXISTS event_stage_manager (
  event_id TEXT NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS event_stage_manager_event_idx ON event_stage_manager(event_id);


CREATE TABLE IF NOT EXISTS event_participant (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  department_id TEXT REFERENCES event_department(id) ON DELETE SET NULL,
  role          TEXT NOT NULL DEFAULT 'participant',
  UNIQUE (event_id, user_id)
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
  user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  PRIMARY KEY (item_id, user_id)
);

CREATE INDEX IF NOT EXISTS schedule_item_participant_item_idx ON schedule_item_participant(item_id);

CREATE TABLE IF NOT EXISTS event_call_time (
  id               TEXT PRIMARY KEY,
  event_id         TEXT NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  department_id    TEXT REFERENCES event_department(id) ON DELETE SET NULL,
  call_at          TIMESTAMPTZ NOT NULL,
  schedule_item_id TEXT REFERENCES event_schedule_item(id) ON DELETE SET NULL,
  notes            TEXT NOT NULL DEFAULT '',
  rsvp             TEXT CHECK (rsvp IN ('yes', 'no', 'tentative')),
  rsvp_at          TIMESTAMPTZ,
  confirmed_at     TIMESTAMPTZ
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
  chat_id          TEXT,
  created_via      TEXT NOT NULL DEFAULT 'explicit'
                   CHECK (created_via IN ('explicit', 'dept_auto', 'poc'))
);

-- 存量库补列守卫（幂等；必须位于 CREATE TABLE 之后——语句顺序即执行顺序）
ALTER TABLE event_tech_req ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'explicit'
  CHECK (created_via IN ('explicit', 'dept_auto', 'poc'));

CREATE INDEX IF NOT EXISTS event_tech_req_event_idx ON event_tech_req(event_id);

CREATE TABLE IF NOT EXISTS event_tech_req_item (
  req_id  TEXT NOT NULL REFERENCES event_tech_req(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES event_schedule_item(id) ON DELETE CASCADE,
  PRIMARY KEY (req_id, item_id)
);

CREATE INDEX IF NOT EXISTS event_tech_req_item_req_idx ON event_tech_req_item(req_id);

CREATE TABLE IF NOT EXISTS event_tech_assignee (
  req_id  TEXT NOT NULL REFERENCES event_tech_req(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  PRIMARY KEY (req_id, user_id)
);

-- ── Reports ───────────────────────────────────────────────────────────────────

-- ── Wiki（批C PR-C1：内容实体——未来独立文档库；命名跟飞书）────────────────────
-- report/note 的本体拆分产物：wiki=内容内禀（title/body/mentions/作者），
-- event_report / event_report_note 退化为纯挂载边。

CREATE TABLE IF NOT EXISTS wiki (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  title         TEXT        NULL,
  body          TEXT        NOT NULL DEFAULT '',
  mentions      JSONB       NOT NULL DEFAULT '[]',
  created_by    UUID        NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wiki_production_idx ON wiki (production_id);

CREATE TABLE IF NOT EXISTS wiki_comment (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wiki_id           UUID        NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  parent_comment_id UUID        NULL REFERENCES wiki_comment(id) ON DELETE CASCADE,
  user_id           UUID        NULL REFERENCES app_user(id),
  author_name       TEXT        NOT NULL,
  content           TEXT        NOT NULL,
  mentions          JSONB       NOT NULL DEFAULT '[]',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wiki_comment_wiki_idx ON wiki_comment (wiki_id, created_at);

-- event_report = event↔wiki 挂载边（id 即边 id；发布是这次挂载的生命周期）
CREATE TABLE IF NOT EXISTS event_report (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  report_type  TEXT NOT NULL DEFAULT 'rehearsal',
  wiki_id      UUID NOT NULL REFERENCES wiki(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS event_report_event_idx ON event_report(event_id);

-- event_report_note = report边↔wiki×dept 挂载边（per-dept 联合关系）
CREATE TABLE IF NOT EXISTS event_report_note (
  id             TEXT PRIMARY KEY,
  report_id      TEXT NOT NULL REFERENCES event_report(id) ON DELETE CASCADE,
  department_id  TEXT NOT NULL REFERENCES event_department(id) ON DELETE CASCADE,
  wiki_id        UUID NOT NULL REFERENCES wiki(id),
  -- 创建通道（批C C3）：dept=本部门 / wildcard=通配权 / moderator=event 编辑者；
  -- POC 的 ud 门 = dept/<D>/notes@edit|delete 行 ∧ created_via='dept'（导演提的不可被 POC 删）
  created_via    TEXT NOT NULL DEFAULT 'dept' CHECK (created_via IN ('dept', 'wildcard', 'moderator')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_report_note_report_idx ON event_report_note(report_id);

CREATE TABLE IF NOT EXISTS event_report_read (
  report_id TEXT NOT NULL REFERENCES event_report(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  read_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, user_id)
);

-- event_report_reply 已拆入 wiki_comment（migrate-report-note-wiki-split.sql）

-- ── Platform identities ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_platform_identity (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  platform_id      TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  label            TEXT,
  is_login_method  BOOLEAN NOT NULL DEFAULT false,
  is_primary       BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform_id, platform_user_id)
);

-- At most one primary email per user
CREATE UNIQUE INDEX IF NOT EXISTS upi_primary_email_uniq
  ON user_platform_identity(user_id)
  WHERE platform_id = 'email' AND is_primary = true;

CREATE INDEX IF NOT EXISTS upi_user_id_idx ON user_platform_identity(user_id);

CREATE TABLE IF NOT EXISTS notification_preference (
  user_id              UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  scope_type           TEXT NOT NULL,
  scope_id             TEXT NOT NULL DEFAULT '',
  platform_identity_id UUID NOT NULL REFERENCES user_platform_identity(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS production_platform_channel (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id       TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  org_id              TEXT,
  platform_id         TEXT NOT NULL,
  platform_channel_id TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ppc_prod_org_uniq
  ON production_platform_channel(production_id, COALESCE(org_id, ''));

-- ── Approval Request（Phase 7）────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approval_request (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,

  subject_id      UUID NOT NULL REFERENCES app_user(id),
  type            TEXT NOT NULL CHECK (type IN (
                    'resource_access',
                    'member_exit',
                    'owner_transfer'
                  )),

  resource_type       TEXT NULL,
  resource_id         TEXT NULL DEFAULT '*',
  resource_sub        TEXT NULL DEFAULT '*',
  permission_level    TEXT NULL,
  grant_type          TEXT NULL CHECK (grant_type IN ('permanent', 'ttl')),
  ttl_duration        INTERVAL NULL,
  note                TEXT NULL,

  CONSTRAINT approval_resource_fields_required
    CHECK (type != 'resource_access' OR (resource_type IS NOT NULL AND permission_level IS NOT NULL)),

  status          TEXT NOT NULL DEFAULT 'pending_resource'
                  CHECK (status IN (
                    'pending_supervisor',
                    'pending_resource',
                    'approved',
                    'rejected',
                    'cancelled'
                  )),

  escalation_chain  JSONB NOT NULL DEFAULT '[]',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ NULL,
  resolved_by     UUID NULL REFERENCES app_user(id),
  granted_at      TIMESTAMPTZ NULL,
  expires_at      TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS approval_request_production_status_idx
  ON approval_request (production_id, status);

CREATE INDEX IF NOT EXISTS approval_request_subject_idx
  ON approval_request (subject_id, production_id);

-- ── Notifications ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_subscription (
  user_id           UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  enabled           BOOLEAN NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, notification_type)
);

CREATE TABLE IF NOT EXISTS user_notification (
  id              TEXT PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  production_id   TEXT REFERENCES production(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  view_href       TEXT,
  category        TEXT NOT NULL DEFAULT 'info' CHECK (category IN ('info', 'action', 'warning')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at         TIMESTAMPTZ,
  action_required BOOLEAN NOT NULL DEFAULT false,
  actions         JSONB NOT NULL DEFAULT '[]',
  acted_at        TIMESTAMPTZ,
  action_result   JSONB,
  expired_at      TIMESTAMPTZ,
  approval_request_id UUID REFERENCES approval_request(id) NULL
);

CREATE INDEX IF NOT EXISTS user_notification_user_created_idx
  ON user_notification(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS user_notification_user_unread_idx
  ON user_notification(user_id, read_at)
  WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS user_notification_user_pending_idx
  ON user_notification(user_id, created_at DESC)
  WHERE action_required = true AND acted_at IS NULL;
CREATE INDEX IF NOT EXISTS user_notification_entity_idx
  ON user_notification(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS user_notification_approval_idx
  ON user_notification (approval_request_id)
  WHERE approval_request_id IS NOT NULL;

-- ── Bot testers ───────────────────────────────────────────────────────────────
-- Intentionally uses open_id: this is a Feishu-layer control table used for
-- bot feature flags and webhook matching; not part of the internal user ID system.

CREATE TABLE IF NOT EXISTS bot_testers (
  open_id  TEXT PRIMARY KEY,
  name     TEXT NOT NULL DEFAULT '',
  added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Assets ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS asset (
  id                TEXT PRIMARY KEY,
  production_id     TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  uploader_user_id  UUID NOT NULL REFERENCES app_user(id),
  asset_type        TEXT NOT NULL DEFAULT 'reference',
  file_name         TEXT NOT NULL,
  mime_type         TEXT,
  is_universal      BOOLEAN NOT NULL DEFAULT true,
  -- 批D 隐私/公开：可见 = 能力票 ∧ (is_public ∨ ∃挂载边:宿主可见) ∨ publication@view。
  -- 存量迁移置 true（保真）；新建默认隐私
  is_public         BOOLEAN NOT NULL DEFAULT false,
  storage_type      TEXT NOT NULL DEFAULT 'r2',
  feishu_url        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  name              TEXT
);

CREATE INDEX IF NOT EXISTS asset_production_idx ON asset(production_id, created_at DESC);
CREATE INDEX IF NOT EXISTS asset_uploader_idx ON asset(uploader_user_id);

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
  created_by       UUID NOT NULL REFERENCES app_user(id),
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

-- Share tokens for public (unauthenticated) asset preview.
-- one_time=true: token is consumed on first access, but streaming continues for 4h (grace period).
-- expires_at=null + one_time=false: permanent token (discouraged; prefer long-expiry time_limited).
CREATE TABLE IF NOT EXISTS asset_share_token (
  token         TEXT        PRIMARY KEY,
  asset_id      TEXT        NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  created_by    UUID        NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  label         TEXT,
  expires_at    TIMESTAMPTZ,
  one_time      BOOLEAN     NOT NULL DEFAULT FALSE,
  used_at       TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS asset_share_token_asset_idx ON asset_share_token(asset_id);

-- ── Scene table view configs ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scene_table_view_config (
  id            TEXT PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  view_name     TEXT NOT NULL DEFAULT '默认视图',
  is_default    BOOLEAN NOT NULL DEFAULT false,
  config        JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scene_table_view_user_prod_idx
  ON scene_table_view_config (user_id, production_id);

CREATE UNIQUE INDEX IF NOT EXISTS scene_table_view_one_default_idx
  ON scene_table_view_config (user_id, production_id) WHERE is_default;

-- ── Milestones ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS milestone (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  end_date      DATE NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS milestone_production_idx ON milestone(production_id, end_date);

-- ── Announcements ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS production_announcement (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  is_pinned     BOOLEAN NOT NULL DEFAULT false,
  created_by    UUID NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS production_announcement_production_idx
  ON production_announcement(production_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS production_announcement_pinned_unique
  ON production_announcement(production_id) WHERE is_pinned = true;

-- 公告已读追踪
CREATE TABLE IF NOT EXISTS announcement_read (
  announcement_id TEXT NOT NULL REFERENCES production_announcement(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE INDEX IF NOT EXISTS announcement_read_announcement_idx
  ON announcement_read(announcement_id);

-- ── Phase 2 (#137): 成员关系模型 ─────────────────────────────────────────────

-- production_member 新增字段（supervisor_id、status）
ALTER TABLE production_member
  ADD COLUMN IF NOT EXISTS supervisor_id UUID REFERENCES app_user(id) NULL,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending_exit', 'disputed', 'exited', 'suspended'));

-- production_member_role：用 role_id FK 替代 roles TEXT[] 字符串数组
CREATE TABLE IF NOT EXISTS production_member_role (
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role_id       TEXT NOT NULL REFERENCES production_role(id) ON DELETE CASCADE,
  PRIMARY KEY (production_id, user_id, role_id)
);

CREATE INDEX IF NOT EXISTS pmr_user_prod_idx ON production_member_role (production_id, user_id);

-- production_dept：新部门表（替代 event_department，数据迁移在 Phase 3）
CREATE TABLE IF NOT EXISTS production_dept (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  parent_id       UUID        REFERENCES production_dept(id) NULL,
  permissions     TEXT[]      NOT NULL DEFAULT '{}',
  allowed_cue_types TEXT[]    NOT NULL DEFAULT '{}',
  display_order   INTEGER     NOT NULL DEFAULT 0,
  chat_id         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS production_dept_name_unique_idx
  ON production_dept (production_id, name, COALESCE(parent_id::text, ''));

CREATE INDEX IF NOT EXISTS production_dept_production_idx
  ON production_dept (production_id, display_order);

CREATE INDEX IF NOT EXISTS production_dept_parent_idx
  ON production_dept (parent_id);

-- production_dept_member
CREATE TABLE IF NOT EXISTS production_dept_member (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  dept_id         UUID        NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  is_poc          BOOLEAN     NOT NULL DEFAULT false,
  poc_extra_permissions   TEXT[] NOT NULL DEFAULT '{}',
  poc_blocked_permissions TEXT[] NOT NULL DEFAULT '{}',  -- 含原 poc_block_write_from_children 语义
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, dept_id)
);

CREATE INDEX IF NOT EXISTS pdm_prod_user_idx ON production_dept_member (production_id, user_id);
CREATE INDEX IF NOT EXISTS pdm_dept_idx      ON production_dept_member (dept_id);

-- production_member_tag（系统预设 + 演出自定义标签定义）
CREATE TABLE IF NOT EXISTS production_member_tag (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT REFERENCES production(id) ON DELETE CASCADE NULL,
  name          TEXT NOT NULL,
  is_system     BOOLEAN NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS pmt_system_name_idx
  ON production_member_tag (name) WHERE production_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pmt_prod_name_idx
  ON production_member_tag (production_id, name) WHERE production_id IS NOT NULL;

INSERT INTO production_member_tag (name, is_system)
VALUES ('正式', true), ('副', true), ('助理', true), ('实习', true), ('顾问', true), ('外包', true)
ON CONFLICT (name) WHERE production_id IS NULL DO NOTHING;

-- production_member_tag_assignment（成员-标签关联）
CREATE TABLE IF NOT EXISTS production_member_tag_assignment (
  production_id TEXT NOT NULL REFERENCES production(id)            ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES app_user(id)              ON DELETE CASCADE,
  tag_id        UUID NOT NULL REFERENCES production_member_tag(id) ON DELETE CASCADE,
  PRIMARY KEY (production_id, user_id, tag_id)
);

CREATE INDEX IF NOT EXISTS pmta_user_prod_idx
  ON production_member_tag_assignment (production_id, user_id);

-- ── Resource Permission Level（Phase 2c）──────────────────────────────────────
-- resource_grant.permission_level 的合法值 lookup 表。
-- 引入新 resource_type 的 migration 必须先在此表插入对应行，再写 grant 数据。

CREATE TABLE IF NOT EXISTS resource_permission_level (
  resource_type    TEXT    NOT NULL,
  permission_level TEXT    NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (resource_type, permission_level)
);

INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  -- cue_list 已 REST 化（批A）：只余四动词（view/edit 在此，create/delete 在下方批0 INSERT）
  ('cue_list',    'view',           1),
  ('cue_list',    'edit',           3),
  -- scene 已 REST 化（批E PR-E1）：view/edit 沿用为动词（mount→mounts 面、manage 退役），
  -- create/delete 在批0 INSERT；结构型资源无 grants 段（§0.10 持有者判据）
  ('scene',       'view',           1),
  ('scene',       'edit',           3),
  -- event 已 REST 化（批B）：view/edit 沿用为动词，create/delete 在批0 INSERT
  ('event',       'view',           1),
  ('event',       'edit',           2),
  -- report 已 REST 化（批C）：view/edit 沿用为动词，create/delete 在批0 INSERT
  ('report',      'view',           1),
  ('report',      'edit',           2),
  -- tech_req 已更名 task（批B），词汇见下方 task 四动词 INSERT
  -- note 过渡类型（批C）：manage 退役，view/edit 沿用为动词
  ('note',        'view',           1),
  ('note',        'edit',           2),
  ('script_view', 'view',           1),
  ('script_view', 'edit',           2),
  ('script_view', 'manage',         3),
  -- asset 已 REST 化（批D）：view/edit 沿用为动词（mount→publication 面、manage 退役），
  -- create/delete 在批0 INSERT
  ('asset',       'view',           1),
  ('asset',       'edit',           3),
  -- dept = event_department（批C C3）：notes 权限面锚点，四动词
  ('dept',        'view',           0),
  ('dept',        'create',         0),
  ('dept',        'edit',           0),
  ('dept',        'delete',         0),
  -- character / tag_group（批E PR-E1）：结构型资源四动词；tag_option 并入 tag_group 树
  ('character',   'view',           0),
  ('character',   'create',         0),
  ('character',   'edit',           0),
  ('character',   'delete',         0),
  ('tag_group',   'view',           0),
  ('tag_group',   'create',         0),
  ('tag_group',   'edit',           0),
  ('tag_group',   'delete',         0)
ON CONFLICT DO NOTHING;

-- 权限REST化 批0（add-rest-verbs.sql）：四动词闭集的 create/delete 行。
-- sort_order=0 保证旧线性 checker（sort_order >= 比较）不会误判命中新动词行。
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('cue_list',    'create', 0), ('cue_list',    'delete', 0),
  ('scene',       'create', 0), ('scene',       'delete', 0),
  ('event',       'create', 0), ('event',       'delete', 0),
  ('report',      'create', 0), ('report',      'delete', 0),
  ('note',        'create', 0), ('note',        'delete', 0),
  ('script_view', 'create', 0), ('script_view', 'delete', 0),
  ('asset',       'create', 0), ('asset',       'delete', 0)
ON CONFLICT DO NOTHING;

-- 批B（add-task-verbs.sql）：task 类型四动词（tech_req 更名承接）
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('task', 'view', 0), ('task', 'create', 0), ('task', 'edit', 0), ('task', 'delete', 0)
ON CONFLICT DO NOTHING;

-- ── Resource Grant（Phase 1 #158，Phase 2c 修正）──────────────────────────────
-- 所有实际资源权限的单一权威来源。

CREATE TABLE IF NOT EXISTS resource_grant (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  resource_type   TEXT        NOT NULL,
  resource_id     TEXT        NOT NULL DEFAULT '*',   -- 实例 ID；'*' = 所有实例
  resource_sub    TEXT        NOT NULL DEFAULT '*',   -- 子类型/字段；'*' = 所有子类型
  permission_level TEXT       NOT NULL,
  CONSTRAINT resource_grant_level_fk
    FOREIGN KEY (resource_type, permission_level)
    REFERENCES resource_permission_level (resource_type, permission_level)
    DEFERRABLE INITIALLY DEFERRED,
  grant_source    TEXT        NOT NULL CHECK (grant_source IN (
                    'self_confirmed', 'auto', 'approval', 'direct', 'assigned', 'migrated'
                  )),
  confirmed_by    UUID        NULL REFERENCES app_user(id),  -- auto/migrated grant 时为 NULL
  approval_id     UUID        NULL REFERENCES approval_request(id),
  is_revoked      BOOLEAN     NOT NULL DEFAULT false,
  revoked_reason  TEXT        NULL CHECK (revoked_reason IN (
                    'role_change', 'dept_change', 'dept_dissolved', 'poc_change', 'manual', 'member_removed'
                  )),
  expires_at      TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- expires_at 条件不能用 NOW()（非 IMMUTABLE），唯一性保护依赖 is_revoked；
-- 到期 grant 需由应用层在重发前先标记 is_revoked = true。
CREATE UNIQUE INDEX IF NOT EXISTS resource_grant_active_unique_idx
  ON resource_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false;

CREATE INDEX IF NOT EXISTS resource_grant_lookup_idx
  ON resource_grant (production_id, resource_type, resource_id, resource_sub, user_id)
  WHERE is_revoked = false;

-- ── Atomic Permission Grant（Phase 2c）────────────────────────────────────────
-- 原子权限 key 的个人 grant 记录。

CREATE TABLE IF NOT EXISTS atomic_permission_grant (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  permission_key  TEXT        NOT NULL,
  grant_source    TEXT        NOT NULL CHECK (grant_source IN (
                    'self_confirmed', 'auto', 'approval', 'direct', 'assigned', 'migrated'
                  )),
  confirmed_by    UUID        NULL REFERENCES app_user(id),  -- auto/migrated grant 时为 NULL
  approval_id     UUID        NULL REFERENCES approval_request(id),
  is_revoked      BOOLEAN     NOT NULL DEFAULT false,
  revoked_reason  TEXT        NULL CHECK (revoked_reason IN (
                    'role_change', 'dept_change', 'poc_change', 'manual', 'member_removed'
                  )),
  expires_at      TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS atomic_permission_grant_active_unique_idx
  ON atomic_permission_grant (production_id, user_id, permission_key)
  WHERE is_revoked = false;

CREATE INDEX IF NOT EXISTS atomic_permission_grant_lookup_idx
  ON atomic_permission_grant (production_id, user_id)
  WHERE is_revoked = false;

-- ── Resource Dept Manage（Phase 3）────────────────────────────────────────────
-- 部门-资源结构性管理权（信号表，非 grant 表）。
CREATE TABLE IF NOT EXISTS resource_dept_manage (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  dept_id       UUID        NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  resource_type TEXT        NOT NULL,
  resource_id   TEXT        NOT NULL DEFAULT '*',
  resource_sub  TEXT        NOT NULL DEFAULT '*',
  established_by UUID       NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (production_id, dept_id, resource_type, resource_id, resource_sub)
);

CREATE INDEX IF NOT EXISTS rdm_production_resource_idx
  ON resource_dept_manage (production_id, resource_type, resource_id);

CREATE INDEX IF NOT EXISTS rdm_dept_idx
  ON resource_dept_manage (dept_id);

-- ── Resource Person Manage ────────────────────────────────────────────────────
-- Per-resource individual person management (complements resource_dept_manage).
CREATE TABLE IF NOT EXISTS resource_person_manage (
  id             uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  production_id  text        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id        uuid        NOT NULL REFERENCES app_user(id)   ON DELETE CASCADE,
  resource_type  text        NOT NULL,
  resource_id    text        NOT NULL DEFAULT '*',
  resource_sub   text        NOT NULL DEFAULT '*',
  established_by uuid        NOT NULL REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (production_id, user_id, resource_type, resource_id, resource_sub)
);

CREATE INDEX IF NOT EXISTS rpm_production_resource_idx
  ON resource_person_manage (production_id, resource_type, resource_id);

-- ── Production Approval Config（Phase 3）──────────────────────────────────────
-- 演出级审批 TTL 配置，演出创建时自动写入默认行。
CREATE TABLE IF NOT EXISTS production_approval_config (
  production_id TEXT        PRIMARY KEY REFERENCES production(id) ON DELETE CASCADE,
  ttl_hours     INTEGER     NOT NULL DEFAULT 24
                            CHECK (ttl_hours > 0 AND ttl_hours <= 720),
  updated_by    UUID        NULL REFERENCES app_user(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Grant Template（权限REST化 批A，总表 §0.7/§0.8）──────────────────────────
-- 纯全局权限模板（ROLE_TEMPLATE_PERMISSIONS 的 DB 镜像）：production_type（NULL=通用）
-- × 角色名（'*'=成员基础）→ permission_key。仅作 fallback/seed；演出内实际资格在
-- production_role_permission / production_dept_permission / production_member_permission。
-- permission_key 词汇：原子键（迁移期）或节点串 node:<type>/<id>[/<sub>]@<verb>。

CREATE TABLE IF NOT EXISTS grant_template (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_type TEXT        NULL,
  role_name       TEXT        NOT NULL,
  permission_key  TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS grant_template_unique_idx
  ON grant_template (COALESCE(production_type, ''), role_name, permission_key);

INSERT INTO grant_template (role_name, permission_key) VALUES
  ('*', 'script:comment')
ON CONFLICT DO NOTHING;

-- 全局通用模板种子（批A cue 域，保真迁移；见 add-grant-template.sql）
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('*', 'node:cue_list/*/meta@view'),
  ('*', 'node:cue_list/*/cues@view'),
  ('*', 'node:cue_list/*/cues/comments@create')
ON CONFLICT DO NOTHING;

INSERT INTO grant_template (role_name, permission_key)
SELECT r.name, 'node:cue_list/*@create'
FROM (VALUES ('音响设计'), ('灯光设计'), ('多媒体设计'), ('舞美设计'), ('服化设计'),
             ('舞台监督'), ('作曲'), ('编曲'), ('音乐导演')) AS r(name)
ON CONFLICT DO NOTHING;

-- ── Production Dept Permission（批A，六步链第 3 步资格源）──────────────────────
-- dept 免审批区间；取代 production_dept.permissions 数组的终局形态。

CREATE TABLE IF NOT EXISTS production_dept_permission (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id  TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  dept_id        UUID        NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  permission_key TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dept_id, permission_key)
);

CREATE INDEX IF NOT EXISTS production_dept_permission_prod_idx
  ON production_dept_permission (production_id, dept_id);

-- 全局模板种子（批B event 域，保真迁移；见 add-task-verbs.sql）
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('*', 'node:event/*/meta@view'),
  ('*', 'node:event/*/details@view'),
  ('*', 'node:event/*/followers@create')
ON CONFLICT DO NOTHING;

INSERT INTO grant_template (role_name, permission_key)
SELECT r.name, k.key
FROM (VALUES ('舞台监督'), ('制作人')) AS r(name)
CROSS JOIN (VALUES
  ('node:event/*@create'),
  ('node:event/*/chat@create'),
  ('node:event/*/call_sheet@view'),
  ('node:event/*/reports@view'),
  ('node:event/*/publication@view'),
  ('node:task/*@view'),
  ('node:task/*@delete')
) AS k(key)
ON CONFLICT DO NOTHING;

INSERT INTO grant_template (role_name, permission_key)
SELECT r.name, 'node:task/*@view'
FROM (VALUES ('导演'), ('副导演'), ('音乐导演')) AS r(name)
ON CONFLICT DO NOTHING;

-- 批C：制作人的报告挂接资格（原 report:create）
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('制作人', 'node:event/*/reports@create')
ON CONFLICT DO NOTHING;

-- 批C C3：导演任意部门发 note（dept 锚通配）
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('导演', 'node:dept/*/notes@create')
ON CONFLICT DO NOTHING;

-- 批D：asset 能力票（全员三枚，MEMBER_BASE 保真）+ 制作人 any 全系
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('*', 'node:asset/*/meta@view'),
  ('*', 'node:asset/*/file@view'),
  ('*', 'node:asset/*/shares@create')
ON CONFLICT DO NOTHING;

INSERT INTO grant_template (role_name, permission_key)
SELECT '制作人', k FROM (VALUES
  ('node:asset/*@create'), ('node:asset/*@delete'),
  ('node:asset/*/meta@edit'), ('node:asset/*/file@create'),
  ('node:asset/*/publication@create'), ('node:asset/*/publication@delete')
) AS t(k)
ON CONFLICT DO NOTHING;

-- 批E PR-E1：scene/character 三态目录默认（MEMBER_BASE 保真）
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('*', 'node:scene/*/meta@view'),
  ('*', 'node:scene/*/synopsis@view'),
  ('*', 'node:scene/*/action_line@view'),
  ('*', 'node:scene/*/music@view'),
  ('*', 'node:scene/*/stage_notes@view'),
  ('*', 'node:character/*/meta@view'),
  ('*', 'node:character/*/gender@view'),
  ('*', 'node:character/*/biography@view'),
  ('*', 'node:character/*/role_type@view'),
  ('*', 'node:character/*/members@view')
ON CONFLICT DO NOTHING;
