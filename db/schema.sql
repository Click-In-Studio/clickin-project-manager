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
  owner_id          UUID NOT NULL REFERENCES app_user(id),
  watermark_enabled BOOLEAN NOT NULL DEFAULT false
);

-- ── Versions ──────────────────────────────────────────────────────────────────

-- 版本退役 Phase B（migrate-version-retire.sql）：name/description/tags/status
-- 已删——版本不再是用户概念。表本体与 parent_version_id 留作未来「历史记录 /
-- checkpoint」的线性链地基。
CREATE TABLE IF NOT EXISTS version (
  id                TEXT PRIMARY KEY,
  production_id     TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  parent_version_id TEXT REFERENCES version(id) ON DELETE SET NULL,
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
-- cue type authorization now managed via dept_cue_list_template（声明表，§3.5）

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
-- Access is now managed via production_member_grant (resource_type='cue_list').

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
-- report_doc_wiki_id（event 目录文档锚点）在 Wiki 段落 ALTER 补列（wiki 表定义在后）

CREATE INDEX IF NOT EXISTS production_event_production_idx ON production_event(production_id, start_time);

-- ── Organization tree ─────────────────────────────────────────────────────────
-- event_department / event_department_member dropped in
-- migrate-merge-event-department.sql — 并入 production_dept（kind 列承接
-- 'group' 用户组语义）/ production_dept_member，事件业务 FK 直指组织树。
-- 部门权限行在 production_dept_permission；cue 声明在 dept_cue_list_template。

CREATE TABLE IF NOT EXISTS production_dept (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  parent_id       UUID        REFERENCES production_dept(id) NULL,
  kind            TEXT        NOT NULL DEFAULT 'dept',  -- 'dept'=部门（可提 notes）/'group'=用户组（仅选人）
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

CREATE TABLE IF NOT EXISTS production_dept_member (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  dept_id         UUID        NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  is_poc          BOOLEAN     NOT NULL DEFAULT false,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, dept_id)
);

CREATE INDEX IF NOT EXISTS pdm_prod_user_idx ON production_dept_member (production_id, user_id);
CREATE INDEX IF NOT EXISTS pdm_dept_idx      ON production_dept_member (dept_id);

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
  department_id UUID REFERENCES production_dept(id) ON DELETE SET NULL,
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
  dept_id UUID NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, dept_id)
);

-- ── 用户组（add-event-group-1-entity.sql）────────────────────────────────────────────────
-- 部门 + 人的集合，自带 POC。两型由 event_id 是否为 NULL 判定：
--   A 型（event 非空）该 event 专属，门 = hasEventContentEdit
--   B 型（event 为空）项目级常驻编制，门 = node:user_group/*，设 POC 另需 poc@edit
-- 与 schedule_item_participant / _department **并联**，不是串联——直挂人/部门的路保留。

CREATE TABLE IF NOT EXISTS event_group (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  event_id      TEXT        REFERENCES production_event(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  -- 刻意没有 location：组回答「谁」不回答「哪儿」，地点是 event_schedule_item 的属性
  color         TEXT,
  order_index   INTEGER     NOT NULL DEFAULT 0,
  poc_dept_id   UUID        REFERENCES production_dept(id) ON DELETE SET NULL,
  poc_user_id   UUID        REFERENCES app_user(id)        ON DELETE SET NULL,
  created_by    UUID        NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_group_poc_single CHECK (num_nonnulls(poc_dept_id, poc_user_id) <= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS event_group_name_unique_idx
  ON event_group (production_id, COALESCE(event_id, ''), name);
CREATE INDEX IF NOT EXISTS event_group_production_idx ON event_group (production_id);
CREATE INDEX IF NOT EXISTS event_group_event_idx      ON event_group (event_id) WHERE event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_group_member (
  group_id UUID        NOT NULL REFERENCES event_group(id)  ON DELETE CASCADE,
  dept_id  UUID        REFERENCES production_dept(id)       ON DELETE CASCADE,
  user_id  UUID        REFERENCES app_user(id)              ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_group_member_one_kind CHECK (num_nonnulls(dept_id, user_id) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS event_group_member_dept_idx
  ON event_group_member (group_id, dept_id) WHERE dept_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS event_group_member_user_idx
  ON event_group_member (group_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS schedule_item_group (
  item_id  TEXT NOT NULL REFERENCES event_schedule_item(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES event_group(id)         ON DELETE CASCADE,
  PRIMARY KEY (item_id, group_id)
);

CREATE INDEX IF NOT EXISTS schedule_item_group_group_idx ON schedule_item_group (group_id);

-- ── 用户组冻结快照（add-event-group-3-freeze.sql）──────────────────────────────────
-- 冻的是「event × group 的成员解析结果」，不是 group 本身——B 型组被 5 个 event 引用，
-- 冻了 3 个，组本身照常改，只影响另外 2 个。故键含 event_id。
-- 完整快照 = 人员 + 人员关系（via_dept_*，他当时以什么身份在场）+ 当时的 POC。
-- 所有 *_name 是刻意的文本冗余：审计要「当时叫什么」，不随实体改名而漂。
-- refreeze 追加不覆盖：unfreeze 置 released_at，再冻插新一版，历史全留。

CREATE TABLE IF NOT EXISTS event_group_freeze (
  event_id      TEXT        NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  -- 刻意不设 FK：快照自给自足，组行删掉后仍解析得出（CASCADE 会删审计，
  -- SET NULL 与 PK 的 NOT NULL 冲突）
  group_id      UUID        NOT NULL,
  frozen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at   TIMESTAMPTZ,
  group_name    TEXT        NOT NULL,
  poc_dept_id   UUID        REFERENCES production_dept(id) ON DELETE SET NULL,
  poc_dept_name TEXT,
  poc_user_id   UUID        REFERENCES app_user(id) ON DELETE SET NULL,
  poc_user_name TEXT,
  frozen_by     UUID        REFERENCES app_user(id) ON DELETE SET NULL,
  PRIMARY KEY (event_id, group_id, frozen_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS event_group_freeze_active_idx
  ON event_group_freeze (event_id, group_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS event_group_freeze_event_idx ON event_group_freeze (event_id);

CREATE TABLE IF NOT EXISTS event_group_freeze_member (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      TEXT        NOT NULL,
  group_id      UUID        NOT NULL,
  frozen_at     TIMESTAMPTZ NOT NULL,
  user_id       UUID        REFERENCES app_user(id) ON DELETE SET NULL,
  user_name     TEXT        NOT NULL,
  via_dept_id   UUID        REFERENCES production_dept(id) ON DELETE SET NULL,
  via_dept_name TEXT,
  FOREIGN KEY (event_id, group_id, frozen_at)
    REFERENCES event_group_freeze (event_id, group_id, frozen_at) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS event_group_freeze_member_snapshot_idx
  ON event_group_freeze_member (event_id, group_id, frozen_at);
CREATE INDEX IF NOT EXISTS event_group_freeze_member_user_idx
  ON event_group_freeze_member (user_id) WHERE user_id IS NOT NULL;

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
  department_id    UUID REFERENCES production_dept(id) ON DELETE SET NULL,
  call_at          TIMESTAMPTZ NOT NULL,
  schedule_item_id TEXT REFERENCES event_schedule_item(id) ON DELETE SET NULL,
  notes            TEXT NOT NULL DEFAULT '',
  rsvp             TEXT CHECK (rsvp IN ('yes', 'no', 'tentative')),
  rsvp_at          TIMESTAMPTZ,
  confirmed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS event_call_time_event_idx ON event_call_time(event_id);

-- Task（原 event_tech_req"技术需求"，migrate-task-standalone 独立化）：
-- production 级实体，event/schedule/部门绑定均可选；自身起止时间可选，
-- 有效时间读侧解析链：自身 → 绑定 schedule items min/max → event 起止。
CREATE TABLE IF NOT EXISTS task (
  id             TEXT PRIMARY KEY,
  production_id  TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  event_id       TEXT REFERENCES production_event(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  preset_minutes INTEGER,
  department_id  UUID REFERENCES production_dept(id) ON DELETE SET NULL,
  -- 责任主体的另一支（add-event-group-2-task-subject.sql）：绑用户组而非部门。与 department_id
  -- 互斥（task_subject_single），POC 从组的当前定义解析，见 lib/task-poc.ts。
  group_id       UUID REFERENCES event_group(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  start_time     TIMESTAMPTZ,
  end_time       TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  chat_id        TEXT,
  created_via    TEXT NOT NULL DEFAULT 'explicit'
                 CHECK (created_via IN ('explicit', 'dept_auto', 'poc')),
  -- #236 形状 L：失去最后一个宿主 event 的时刻（NULL=有宿主/从未失去）。
  -- 与 status 正交——status 是工作进度，本列是结构状态；重新绑定事件时清空。
  orphaned_at    TIMESTAMPTZ,
  CONSTRAINT task_time_order_check
    CHECK (start_time IS NULL OR end_time IS NULL OR end_time >= start_time),
  -- 责任主体二选一：POC 必须是责任单点，否则「指派归 POC」没有唯一答案
  CONSTRAINT task_subject_single CHECK (num_nonnulls(department_id, group_id) <= 1)
);

CREATE INDEX IF NOT EXISTS task_group_idx ON task (group_id) WHERE group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS task_event_idx ON task(event_id);
CREATE INDEX IF NOT EXISTS task_orphaned_idx ON task(production_id) WHERE orphaned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_production_idx ON task(production_id);

-- 绑定 schedule item（多对多；应用层不变量：item 必须属于 task.event_id）
CREATE TABLE IF NOT EXISTS task_schedule_item (
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES event_schedule_item(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, item_id)
);

CREATE INDEX IF NOT EXISTS task_schedule_item_task_idx ON task_schedule_item(task_id);

CREATE TABLE IF NOT EXISTS task_assignee (
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  PRIMARY KEY (task_id, user_id)
);

-- （task_milestone 定义在 milestone 表之后——语句顺序即执行顺序）

-- Blocking 依赖边（GitHub 语义：blocking 挡住 blocked；纯信息性不进状态机，
-- isBlocked 读侧派生；应用层写入时递归 CTE 禁环）
CREATE TABLE IF NOT EXISTS task_dependency (
  blocking_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  blocked_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  created_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocking_id, blocked_id),
  CONSTRAINT task_dependency_no_self_check CHECK (blocking_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS task_dependency_blocked_idx ON task_dependency(blocked_id);

-- ── Reports ───────────────────────────────────────────────────────────────────

-- ── Wiki（批C PR-C1 内容实体；wiki 文档库 W1 补树/分享/链接/tag/历史）──────────
-- report/note 的本体拆分产物：wiki=内容内禀（title/body/mentions/作者），
-- event_report / event_report_note 退化为纯挂载边。
-- W1（add-wiki-library.sql）：文档树=内禀 parent_id（标准树非图）；可见性推导
-- （asset 同构）：个人 grant 行 ∨ is_public ∨ dept 分享面 ∨ ∃挂载边:宿主可见，
-- 挂载/分享面永不物化 grant 行（§0.9 负面清单），新建默认隐私。

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS wiki (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  title         TEXT        NULL,
  body          TEXT        NOT NULL DEFAULT '',
  mentions      JSONB       NOT NULL DEFAULT '[]',
  created_by    UUID        NULL REFERENCES app_user(id),
  -- W1 文档树：删父提根（SET NULL），排序 fractional index（lib/lex-order.ts）
  parent_id     UUID        NULL REFERENCES wiki(id) ON DELETE SET NULL,
  sort_key      TEXT        NULL,
  is_public     BOOLEAN     NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wiki_production_idx ON wiki (production_id);
CREATE INDEX IF NOT EXISTS wiki_parent_idx     ON wiki (parent_id);
CREATE INDEX IF NOT EXISTS wiki_mentions_idx   ON wiki USING GIN (mentions);
CREATE INDEX IF NOT EXISTS wiki_title_trgm_idx ON wiki USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS wiki_body_trgm_idx  ON wiki USING GIN (body gin_trgm_ops);

-- 交叉引用边（保存时服务端解析正文提取；backlinks/unlinked references 数据基础）
CREATE TABLE IF NOT EXISTS wiki_link (
  source_wiki_id UUID NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  target_wiki_id UUID NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  PRIMARY KEY (source_wiki_id, target_wiki_id)
);

CREATE INDEX IF NOT EXISTS wiki_link_target_idx ON wiki_link (target_wiki_id);

-- 自由 tag（必可手写，非受控词表；production 归属经 wiki join）
CREATE TABLE IF NOT EXISTS wiki_tag (
  wiki_id UUID NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (wiki_id, tag)
);

CREATE INDEX IF NOT EXISTS wiki_tag_tag_idx ON wiki_tag (tag);

-- 部门分享面（结构面：判定时查部门成员，部门变动零 sweep；不走区间不落行）
CREATE TABLE IF NOT EXISTS wiki_dept_share (
  wiki_id    UUID        NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  dept_id    UUID        NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wiki_id, dept_id)
);

-- 线性历史（每次内容 update 落一行；origin 为 AI 化 provenance 预留）
CREATE TABLE IF NOT EXISTS wiki_revision (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wiki_id        UUID        NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  title          TEXT        NULL,
  body           TEXT        NOT NULL,
  mentions       JSONB       NOT NULL DEFAULT '[]',
  author_user_id UUID        NULL REFERENCES app_user(id),
  origin         TEXT        NOT NULL DEFAULT 'user',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wiki_revision_wiki_idx ON wiki_revision (wiki_id, created_at);

-- AI propose staging（add-wiki-proposal.sql + add-wiki-proposal-actions.sql +
-- add-wiki-proposal-tag.sql）：production.wiki_propose_* 工具调用的落地凭证，
-- 覆盖 create/update/delete/move/tag 五种动作。不复用 wiki_revision.origin——
-- 该表是「已发生的真实历史」，没有拒绝/拦截态。target_wiki_id=被操作的既有
-- 文档（create 没有）；parent_wiki_id 对 create/move 是「新父」，对
-- update/delete/tag 不使用；tags 只有 tag 动作用（整体替换语义）。
CREATE TABLE IF NOT EXISTS wiki_proposal (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  tool_call_id    TEXT        NOT NULL,
  proposed_by     UUID        NOT NULL REFERENCES app_user(id),
  action          TEXT        NOT NULL DEFAULT 'create'
                    CHECK (action IN ('create', 'update', 'delete', 'move', 'tag')),
  target_wiki_id  UUID        NULL REFERENCES wiki(id) ON DELETE SET NULL,
  parent_wiki_id  UUID        NULL REFERENCES wiki(id) ON DELETE SET NULL,
  title           TEXT        NULL,
  body            TEXT        NOT NULL DEFAULT '',
  tags            TEXT[]      NULL,
  summary         TEXT        NOT NULL DEFAULT '',
  has_permission  BOOLEAN     NOT NULL,
  permission_key  TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'applied', 'blocked_no_permission', 'blocked_business_rule', 'rejected')),
  created_wiki_id UUID        NULL REFERENCES wiki(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ NULL,
  CONSTRAINT wiki_proposal_production_tool_call_uniq UNIQUE (production_id, tool_call_id)
);

-- 默认文档树（add-wiki-default-tree.sql）：production 级 wiki 配置
--（未来扩展：改配置=改根目录名/开关默认目录）；锚点是普通 wiki，锚认 id 不认位置
CREATE TABLE IF NOT EXISTS production_wiki_config (
  production_id        TEXT    PRIMARY KEY REFERENCES production(id) ON DELETE CASCADE,
  reports_tree_enabled BOOLEAN NOT NULL DEFAULT true,
  reports_root_title   TEXT    NOT NULL DEFAULT '报告',
  reports_root_wiki_id UUID    NULL REFERENCES wiki(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- event 目录文档锚点（production_event 定义在 wiki 之前，此处 ALTER 补 FK 列）
ALTER TABLE production_event
  ADD COLUMN IF NOT EXISTS report_doc_wiki_id UUID NULL REFERENCES wiki(id) ON DELETE SET NULL;

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
CREATE INDEX IF NOT EXISTS event_report_wiki_idx  ON event_report(wiki_id);

-- event_report_note = report边↔wiki×dept 挂载边（per-dept 联合关系）
CREATE TABLE IF NOT EXISTS event_report_note (
  id             TEXT PRIMARY KEY,
  report_id      TEXT NOT NULL REFERENCES event_report(id) ON DELETE CASCADE,
  department_id  UUID NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  wiki_id        UUID NOT NULL REFERENCES wiki(id),
  -- 创建通道（批C C3）：dept=本部门 / wildcard=通配权 / moderator=event 编辑者；
  -- POC 的 ud 门 = dept/<D>/notes@edit|delete 行 ∧ created_via='dept'（导演提的不可被 POC 删）
  created_via    TEXT NOT NULL DEFAULT 'dept' CHECK (created_via IN ('dept', 'wildcard', 'moderator')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_report_note_report_idx ON event_report_note(report_id);
CREATE INDEX IF NOT EXISTS event_report_note_wiki_idx   ON event_report_note(wiki_id);

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

  -- #140 审批阶梯位置（add-approval-ladder.sql）：路由由 lib/approval-routing.ts
  -- 单点算出后写在这里，收件箱与鉴权只读 current_approver_ids，不再各自重算。
  current_stage        TEXT    NULL CHECK (current_stage IS NULL OR current_stage IN (
                         'supervisor', 'holder', 'dept_poc', 'ancestor_poc', 'producer', 'owner'
                       )),
  current_stage_depth  INTEGER NOT NULL DEFAULT 0,
  current_approver_ids UUID[]  NOT NULL DEFAULT '{}',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ NULL,
  resolved_by     UUID NULL REFERENCES app_user(id),
  granted_at      TIMESTAMPTZ NULL,
  expires_at      TIMESTAMPTZ NULL,

  -- #256（add-approval-ttl-check.sql）：'ttl' 必须带时长，否则 expires_at 落 NULL
  -- = 永久权限，与申请人/审批人看到的「临时」相反。
  CONSTRAINT approval_request_ttl_duration_required
    CHECK (grant_type IS DISTINCT FROM 'ttl' OR ttl_duration IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS approval_request_production_status_idx
  ON approval_request (production_id, status);

CREATE INDEX IF NOT EXISTS approval_request_subject_idx
  ON approval_request (subject_id, production_id);

CREATE INDEX IF NOT EXISTS approval_request_current_approvers_idx
  ON approval_request USING GIN (current_approver_ids)
  WHERE status IN ('pending_supervisor', 'pending_resource');

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

-- asset_version_rel（资产文件按版本 pin）已随版本退役删除
-- （migrate-version-retire.sql）：文件解析一律 latest-wins。

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

-- Task 里程碑关联（0..n；不约束 task 截止 ≤ 里程碑时间，前端仅软提示。
-- task 表见 event 域段落；本表因引用 milestone 置于其后）
CREATE TABLE IF NOT EXISTS task_milestone (
  task_id      TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  milestone_id TEXT NOT NULL REFERENCES milestone(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, milestone_id)
);

CREATE INDEX IF NOT EXISTS task_milestone_milestone_idx ON task_milestone(milestone_id);

-- ── rundown 版面（add-event-group-4-rundown.sql）────────────────────────────────
-- 组是跨 event 共享的，「在这场排第几列 / 显不显示 / 钉不钉左边」只能记在
-- (event, group) 这一层。is_pinned = 横向滚动时钉在左侧，与冻结快照无关。
-- 地点列是筛选条件不是地点实体——地点是 event_schedule_item 的属性。

CREATE TABLE IF NOT EXISTS event_rundown_column (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       TEXT    NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  group_id       UUID    REFERENCES event_group(id) ON DELETE CASCADE,
  match_location TEXT,
  order_index    INTEGER NOT NULL DEFAULT 0,
  is_visible     BOOLEAN NOT NULL DEFAULT true,
  is_pinned      BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT event_rundown_column_kind CHECK (num_nonnulls(group_id, match_location) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS event_rundown_column_group_idx
  ON event_rundown_column (event_id, group_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS event_rundown_column_location_idx
  ON event_rundown_column (event_id, match_location) WHERE match_location IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_rundown_column_event_idx ON event_rundown_column (event_id);

CREATE TABLE IF NOT EXISTS event_rundown_placement (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   TEXT NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  item_id    TEXT REFERENCES event_schedule_item(id) ON DELETE CASCADE,
  task_id    TEXT REFERENCES task(id) ON DELETE CASCADE,
  color      TEXT,
  CONSTRAINT event_rundown_placement_entry CHECK (num_nonnulls(item_id, task_id) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS event_rundown_placement_item_idx
  ON event_rundown_placement (event_id, item_id) WHERE item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS event_rundown_placement_task_idx
  ON event_rundown_placement (event_id, task_id) WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_rundown_placement_column (
  placement_id UUID NOT NULL REFERENCES event_rundown_placement(id)  ON DELETE CASCADE,
  column_id    UUID NOT NULL REFERENCES event_rundown_column(id)     ON DELETE CASCADE,
  PRIMARY KEY (placement_id, column_id)
);


-- ── 财务（add-finance.sql）────────────────────────────────────────────────────
-- **不是 sensitive 域**：制作人批财务是制作人的核心工作，大剧组的财务岗也能批，
-- 有的剧组 PSM/SM 甚至设计人员能看预算。可见性按面配置（budget / expenses 两个 sub
-- 分开发），不一刀切。这条直接决定审批链——sensitive 会跳过整条链直达 owner。
--
-- 审批**复用路由不复用表**：审批人由 lib/approval-routing 的 buildApprovalLadder 算
-- （与权限申请同一函数），支出的 target 是 `finance/<科目id>/expenses`，于是「共管
-- 部门 POC」那一级自动变成「这个预算科目归哪个部门管」（建科目时写 resource_dept_manage）。
-- 状态字段名与 approval_request 一致好让收件箱同构，但表分开——approval_request 的
-- 批准动作会发权限行，支出批准绝不能发。
--
-- 金额 NUMERIC 不用浮点；currency 现在恒 'CNY'，但必须现在就有——事后补币种会让存量
-- 行的金额含义变成不可判定。

CREATE TABLE IF NOT EXISTS production_budget_category (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT          NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name          TEXT          NOT NULL,
  amount        NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  currency      TEXT          NOT NULL DEFAULT 'CNY',
  dept_id       UUID          REFERENCES production_dept(id) ON DELETE SET NULL,
  order_index   INTEGER       NOT NULL DEFAULT 0,
  notes         TEXT          NOT NULL DEFAULT '',
  created_by    UUID          NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pbc_name_idx ON production_budget_category (production_id, name);
CREATE INDEX IF NOT EXISTS pbc_production_idx ON production_budget_category (production_id);

CREATE TABLE IF NOT EXISTS production_expense (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT          NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  category_id   UUID          REFERENCES production_budget_category(id) ON DELETE SET NULL,
  title         TEXT          NOT NULL,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  currency      TEXT          NOT NULL DEFAULT 'CNY',
  note          TEXT          NOT NULL DEFAULT '',
  submitted_by  UUID          NOT NULL REFERENCES app_user(id),
  status        TEXT          NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  current_stage        TEXT    NULL CHECK (current_stage IS NULL OR current_stage IN (
                         'supervisor', 'holder', 'dept_poc', 'ancestor_poc', 'producer', 'owner'
                       )),
  current_stage_depth  INTEGER NOT NULL DEFAULT 0,
  current_approver_ids UUID[]  NOT NULL DEFAULT '{}',
  escalation_chain     JSONB   NOT NULL DEFAULT '[]',
  resolved_at   TIMESTAMPTZ,
  resolved_by   UUID          REFERENCES app_user(id),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pe_production_idx ON production_expense (production_id);
CREATE INDEX IF NOT EXISTS pe_category_idx   ON production_expense (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pe_approver_idx   ON production_expense USING GIN (current_approver_ids);
CREATE INDEX IF NOT EXISTS pe_pending_idx    ON production_expense (production_id, status) WHERE status = 'pending';

-- ── 物料台账（add-material-ledger.sql）─────────────────────────────────────────
-- 实体物（道具/服装/设备/布景），与 asset（数字资产：文件/R2/飞书链接）不是一回事。
-- 状态只做列表不做状态机：任何状态可改到任何状态，等真实用法跑出规则再加约束——
-- 反过来（先定死再放开）是破坏性的。状态列表可配置，照 production_member_tag 的
-- 范式：production_id 为 NULL 是系统预设，非 NULL 是剧组自定义。
-- 责任方复用 task 的主体抽象（部门 | 用户组，二选一）。

CREATE TABLE IF NOT EXISTS production_material_status (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT    REFERENCES production(id) ON DELETE CASCADE NULL,
  name          TEXT    NOT NULL,
  color         TEXT,
  order_index   INTEGER NOT NULL DEFAULT 0,
  is_system     BOOLEAN NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS pms_system_name_idx
  ON production_material_status (name) WHERE production_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pms_prod_name_idx
  ON production_material_status (production_id, name) WHERE production_id IS NOT NULL;

INSERT INTO production_material_status (production_id, name, color, order_index, is_system) VALUES
  (NULL, '已入库', '#3f6b48', 1, true),
  (NULL, '制作中', '#b45309', 2, true),
  (NULL, '使用中', '#315f66', 3, true),
  (NULL, '待修整', '#8c4654', 4, true),
  (NULL, '已报废', '#6b7280', 5, true)
ON CONFLICT (name) WHERE production_id IS NULL DO NOTHING;

CREATE TABLE IF NOT EXISTS production_material (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  code          TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  category      TEXT        NOT NULL DEFAULT '',
  department_id UUID        REFERENCES production_dept(id) ON DELETE SET NULL,
  group_id      UUID        REFERENCES event_group(id)     ON DELETE SET NULL,
  status_id     UUID        REFERENCES production_material_status(id) ON DELETE SET NULL,
  location      TEXT        NOT NULL DEFAULT '',
  quantity      INTEGER     NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  notes         TEXT        NOT NULL DEFAULT '',
  created_by    UUID        NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT material_owner_single CHECK (num_nonnulls(department_id, group_id) <= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS production_material_code_idx
  ON production_material (production_id, code);
CREATE INDEX IF NOT EXISTS production_material_production_idx
  ON production_material (production_id);
CREATE INDEX IF NOT EXISTS production_material_status_idx
  ON production_material (status_id) WHERE status_id IS NOT NULL;

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

-- production_dept 定义已上移（组织树是事件业务 FK 家族的引用目标，需先建）——
-- 见 production_event 之前的 "Organization tree" 段。

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
-- production_member_grant.permission_level 的合法值 lookup 表。
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
  -- script_view 已 REST 化（批E PR-E3）：view/edit 沿用（manage 退役拆 grants 行集）
  ('script_view', 'view',           1),
  ('script_view', 'edit',           2),
  -- asset 已 REST 化（批D）：view/edit 沿用为动词（mount→publication 面、manage 退役），
  -- create/delete 在批0 INSERT
  ('asset',       'view',           1),
  ('asset',       'edit',           3),
  -- dept = production_dept（批C C3，并表后单一 id 空间）：notes 权限面锚点，四动词
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
  ('tag_group',   'delete',         0),
  -- script（单例，id 恒 '*'）/ dramaturgy（批E PR-E2）：imports 是保留段（批量破坏性）
  ('script',      'view',           0),
  ('script',      'create',         0),
  ('script',      'edit',           0),
  ('script',      'delete',         0),
  ('dramaturgy',  'view',           0),
  ('dramaturgy',  'create',         0),
  ('dramaturgy',  'edit',           0),
  ('dramaturgy',  'delete',         0),
  -- dramaturgy_view 个人视图（批E PR-E3）：所有权=user_id 上下文，publication=公开面（预留）
  ('dramaturgy_view', 'view',       0),
  ('dramaturgy_view', 'create',     0),
  ('dramaturgy_view', 'edit',       0),
  ('dramaturgy_view', 'delete',     0),
  -- 治理域（批F）：production 根实例（id 恒 '*'）；org_dept=production_dept 组织树
  -- （与批C3 dept=production_dept notes 锚区分）；SENSITIVE 键=owner∨行（无 admin 旁路）、
  -- ROOT 三键=owner-only 代码判定（节点入树行不发）
  ('production',   'view', 0), ('production',   'create', 0), ('production',   'edit', 0), ('production',   'delete', 0),
  ('member',       'view', 0), ('member',       'create', 0), ('member',       'edit', 0), ('member',       'delete', 0),
  ('producer',     'view', 0), ('producer',     'create', 0), ('producer',     'edit', 0), ('producer',     'delete', 0),
  ('role',         'view', 0), ('role',         'create', 0), ('role',         'edit', 0), ('role',         'delete', 0),
  ('org_dept',     'view', 0), ('org_dept',     'create', 0), ('org_dept',     'edit', 0), ('org_dept',     'delete', 0),
  ('milestone',    'view', 0), ('milestone',    'create', 0), ('milestone',    'edit', 0), ('milestone',    'delete', 0),
  ('announcement', 'view', 0), ('announcement', 'create', 0), ('announcement', 'edit', 0), ('announcement', 'delete', 0)
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

-- wiki 文档库 W2（add-wiki-library.sql）：wiki 四动词。默认角色不发行
-- （拍板 §4.7 默认不可见，分享/挂载驱动）；制作人通配区间自动覆盖
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('wiki', 'view', 0), ('wiki', 'create', 0), ('wiki', 'edit', 0), ('wiki', 'delete', 0)
ON CONFLICT DO NOTHING;

-- ── Resource Grant（Phase 1 #158，Phase 2c 修正）──────────────────────────────
-- 所有实际资源权限的单一权威来源。

CREATE TABLE IF NOT EXISTS production_member_grant (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  resource_type   TEXT        NOT NULL,
  resource_id     TEXT        NOT NULL DEFAULT '*',   -- 实例 ID；'*' = 所有实例
  resource_sub    TEXT        NOT NULL DEFAULT '*',   -- 子类型/字段；'*' = 所有子类型
  permission_level TEXT       NOT NULL,
  CONSTRAINT production_member_grant_level_fk
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
CREATE UNIQUE INDEX IF NOT EXISTS production_member_grant_active_unique_idx
  ON production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false;

CREATE INDEX IF NOT EXISTS production_member_grant_lookup_idx
  ON production_member_grant (production_id, resource_type, resource_id, resource_sub, user_id)
  WHERE is_revoked = false;

-- atomic_permission_grant：批G G-2 终局 DROP（168 原子键六批退役完毕，
-- 见 lib/permission-migration-ledger.ts RETIRED 清单）

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
-- ── 策略配置中心（#236）────────────────────────────────────────────────────────
-- 【政策】类定式的 production 级开关。value 是 TEXT 不是 BOOLEAN（形状 C/L 有多档键）；
-- 合法取值由 lib/policy-keys.ts 白名单校验，SQL 侧不设 CHECK（新增键零 migration）。
-- 落全量键、不稀疏：缺行回落代码默认会让改默认值静默改变存量演出行为。
CREATE TABLE IF NOT EXISTS production_policy (
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  policy_key    TEXT        NOT NULL,
  value         TEXT        NOT NULL,
  updated_by    UUID        NULL REFERENCES app_user(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (production_id, policy_key)
);

-- 策略改动是项目级、影响所有人的动作，比单条 grant 更需要留痕。
CREATE TABLE IF NOT EXISTS production_policy_audit (
  id            BIGSERIAL   PRIMARY KEY,
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  policy_key    TEXT        NOT NULL,
  old_value     TEXT        NOT NULL,
  new_value     TEXT        NOT NULL,
  changed_by    UUID        NULL REFERENCES app_user(id),
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS production_policy_audit_prod_time_idx
  ON production_policy_audit (production_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS production_approval_config (
  production_id TEXT        PRIMARY KEY REFERENCES production(id) ON DELETE CASCADE,
  ttl_hours     INTEGER     NOT NULL DEFAULT 24
                            CHECK (ttl_hours > 0 AND ttl_hours <= 720),
  updated_by    UUID        NULL REFERENCES app_user(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Grant Template：已退役（#163，migrate-retire-grant-template.sql）──────────
-- 全局角色权限模板（production_type × role_name → permission_key）此前在这张表里。
-- 它是 bootstrap（运行时零读取、只在建演出/建角色时 seed），但放 DB 且无界面会漂
-- ——线上 108 行里 69 行仓库从没记录过。职责已由项目模版接手：
--   lib/production-template.ts（机制）+ lib/templates/*.ts（内容）
-- 且必须接手：那张表的取数是并集，per-type 只能加不能减，而多套模版要削基线。

-- ── Production Dept Permission（批A，六步链第 3 步资格源）──────────────────────
-- dept 免审批区间；取代 production_dept.permissions 数组的终局形态。

CREATE TABLE IF NOT EXISTS production_dept_permission (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id  TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  dept_id        UUID        NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  permission_key TEXT        NOT NULL,
  -- 这一行由谁在管（#274）。按「要改它得去哪儿」划分，不是按谁创建的：
  --   manual   人在权限中心配的 / 项目模版灌的静态区间行 —— 就在权限中心改
  --   template cue 声明行实例化 —— 去权限模版页改声明
  --   resource 资源自身的归属或分享面（建表定式 / cue 表分享 / 事件归属）—— 去该资源页改
  -- 同一枚键只有一行（下方 UNIQUE），故自动通道用 DO UPDATE 升级 manual → template/resource：
  -- 撤声明 / 撤分享时那一行本来就会被按键形收走，标成 manual 会让界面撒谎。
  source         TEXT        NOT NULL DEFAULT 'manual'
                             CHECK (source IN ('manual', 'template', 'resource')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dept_id, permission_key)
);

CREATE INDEX IF NOT EXISTS production_dept_permission_prod_idx
  ON production_dept_permission (production_id, dept_id);

-- ── Cue 表权限模版声明（§3.5，2026-08-13）───────────────────────────────────
-- 类型 × 权限声明：can_create=建表资格；permissions=纯相对键数组（'@view'/'cues@create'…）
-- 建表定式：∀声明部门按数组发实例区间键（production_dept_permission）

CREATE TABLE IF NOT EXISTS dept_cue_list_template (
  production_id  TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  dept_id        UUID NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  template       TEXT NOT NULL,
  can_create     BOOLEAN NOT NULL DEFAULT false,
  permissions    TEXT[] NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dept_id, template)
);

CREATE INDEX IF NOT EXISTS dept_cue_list_template_prod_idx
  ON dept_cue_list_template (production_id, template);

-- ── Cue 表模版类型注册表（#227：production 级可配置，替代代码常量）────────────
-- creator_roles 仅信息展示；建表资格走 dept_cue_list_template.can_create。

CREATE TABLE IF NOT EXISTS production_cue_template_type (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  key           TEXT        NOT NULL,
  abbr_hint     TEXT,
  creator_roles TEXT[]      NOT NULL DEFAULT '{}',
  display_order INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (production_id, key)
);

CREATE INDEX IF NOT EXISTS production_cue_template_type_prod_idx
  ON production_cue_template_type (production_id, display_order);

-- ── 项目邀请（#156：开放链接 + 定向邀请 + 批量认领链接）──────────────────────

CREATE TABLE IF NOT EXISTS production_invite (
  token           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  kind            TEXT        NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'claim')),
  email           TEXT,
  target_user_id  UUID        REFERENCES app_user(id) ON DELETE CASCADE,
  feishu_open_id  TEXT,
  preset_roles    TEXT[]      NOT NULL DEFAULT '{}',
  preset_dept_ids UUID[]      NOT NULL DEFAULT '{}',
  created_by      UUID        NOT NULL REFERENCES app_user(id),
  expires_at      TIMESTAMPTZ,
  max_uses        INTEGER,
  used_count      INTEGER     NOT NULL DEFAULT 0,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS production_invite_prod_idx
  ON production_invite (production_id, created_at DESC);

CREATE TABLE IF NOT EXISTS production_invite_claim (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token           UUID        NOT NULL REFERENCES production_invite(token) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  preset_roles    TEXT[]      NOT NULL DEFAULT '{}',
  preset_dept_ids UUID[]      NOT NULL DEFAULT '{}',
  claimed_by      UUID        REFERENCES app_user(id) ON DELETE SET NULL,
  claimed_at      TIMESTAMPTZ,
  UNIQUE (token, name)
);

CREATE INDEX IF NOT EXISTS production_invite_claim_token_idx
  ON production_invite_claim (token);

-- agents.md 分级注入：制作级/个人级指令（系统级在 openclaw-workspace/AGENTS.md，
-- repo 版本控制不进库）。scope_id 因 scope 类型而异（user uuid / production 短 id），
-- TEXT 不挂 FK，孤儿行无害。
CREATE TABLE IF NOT EXISTS agent_instructions (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'production')),
  scope_id   TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  updated_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_id)
);

-- ── Agent 记忆检索索引（add-agent-memory-index.sql）─────────────────────────
-- 设计出处：MindWeave《OpenClaw记忆检索机制调研与移植设计》。多租户边界=
-- scope 谓词列；pgvector 钉 0.6 兼容面 + vector(1024)（text-embedding-v4）。

CREATE EXTENSION IF NOT EXISTS vector;

-- ── 记忆块（对应 OpenClaw memory_index_chunks + recall_metadata + provenance 合表）──
--
-- 三表合一的理由：OpenClaw 拆表是因为 recall_metadata/provenance 是后加的
-- （可空列 + 旧索引零迁移）；我们全新建表，没有历史包袱，合表省两次 JOIN。
-- 「provenance 是模型经 prose 写不到的列」这条安全属性由写入路径保证（只有
-- 索引器代码写这些列，没有任何 MCP 工具暴露写入口），与拆不拆表无关。
CREATE TABLE IF NOT EXISTS agent_memory_chunk (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 多租户边界：一切查询强制带 scope 谓词。scope_id 多态（user=app_user
  -- UUID 文本 / production=uid() 短串），故无 FK；清理由归属方生命周期驱动。
  scope_type     TEXT        NOT NULL CHECK (scope_type IN ('user', 'production')),
  scope_id       TEXT        NOT NULL,
  -- curated=蒸馏产物 MEMORY.md 切块（常青，不衰减）；episodic=runs.jsonl
  -- 逐条（30 天半衰期）。episodic 永不自动注入是安全属性，检索工具可见。
  source         TEXT        NOT NULL CHECK (source IN ('curated', 'episodic')),
  text           TEXT        NOT NULL,
  -- 关键词车道语料：CJK 逐对 bigram + ASCII 整词（空格分隔，索引器生成）。
  -- 不用 pg_trgm：实测 word_similarity 对连续中文近乎失效（短查询串的
  -- trigram 边界填充在无空格文本上对不上，「张三」对含张三的句子=0 分）；
  -- bigram 切词是中文检索标准做法，也与 OpenClaw FTS5 的 CJK n-gram
  -- tokenizer 同思路。评分=查询 bigram 命中占比（0..1 天然归一）。
  text_tokens    TEXT        NOT NULL,
  -- 内容 hash（sha256 hex）：幂等键 + embedding 缓存键。
  content_hash   TEXT        NOT NULL,
  -- 生成该 embedding 的模型；NULL = 嵌入尚未完成（供应商挂掉时仍索引文本，
  -- 关键词车道可用，向量车道跳过——对应 OpenClaw creation-time fallback）。
  model          TEXT        NULL,
  embedding      vector(1024) NULL,
  -- 召回元数据（对应 recall_metadata；可空=中性，M2 蒸馏升级后才开始产出）
  importance     SMALLINT    NULL CHECK (importance IS NULL OR importance BETWEEN 1 AND 10),
  triggers       TEXT        NULL,
  -- provenance（对应 chunk_provenance；只有索引器写，无任何工具暴露写入口）
  origin_class   TEXT        NOT NULL CHECK (origin_class IN ('owner', 'agent', 'untrusted', 'system')),
  session_kind   TEXT        NOT NULL CHECK (session_kind IN ('interactive', 'cron', 'heartbeat', 'subagent', 'unknown')),
  observed_at    TIMESTAMPTZ NOT NULL,
  supersedes_key TEXT        NULL,
  -- production 域多作者记账（user 域恒等于 scope_id，冗余但统一查询面）
  author_user_id UUID        NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 幂等：同 scope 同 source 下同内容只存一份（也是防召回回环的一半——
  -- 同一事实被反复上报仍是一行）
  UNIQUE (scope_type, scope_id, source, content_hash)
);

-- 向量车道：HNSW + cosine（0.6.0 起可用）。语料量级小（每 scope 千行级），
-- 默认参数足够。
CREATE INDEX IF NOT EXISTS agent_memory_chunk_embedding_idx
  ON agent_memory_chunk USING hnsw (embedding vector_cosine_ops);

-- 关键词车道无专用索引：评分是逐查询 bigram 的 LIKE 命中占比，在 scope
-- 谓词过滤后的行集（每用户千行级）上顺扫，量级内无索引必要。
CREATE INDEX IF NOT EXISTS agent_memory_chunk_scope_idx
  ON agent_memory_chunk (scope_type, scope_id, source);

-- ── embedding 缓存（对应 OpenClaw embedding cache 表）────────────────────────
-- curated 重建是「整 scope 删了重插」，没有缓存的话每次蒸馏都全量重嵌；
-- 按 (model, content_hash) 查重后未变更的行零 API 调用。
CREATE TABLE IF NOT EXISTS agent_memory_embedding_cache (
  model        TEXT         NOT NULL,
  content_hash TEXT         NOT NULL,
  embedding    vector(1024) NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (model, content_hash)
);

-- ── 索引身份（对应 OpenClaw index identity）──────────────────────────────────
-- 运行时配置的 (model, dim) 与此不一致 → 向量车道拒绝服务并要求显式重建，
-- 绝不静默混维度。单行表。
CREATE TABLE IF NOT EXISTS agent_memory_index_meta (
  id         SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  model      TEXT        NOT NULL,
  dim        INTEGER     NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 召回记账（Phase B 晋升门的确定性信号源）─────────────────────────────────
-- memory_search 每次命中记一行：召回频次/查询多样性是 OpenClaw deep 阶段
-- 确定性门的头两个加权信号，从 M1 就开始攒。
CREATE TABLE IF NOT EXISTS agent_memory_recall_log (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chunk_id   UUID        NOT NULL REFERENCES agent_memory_chunk(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL,
  query_hash TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_memory_recall_log_chunk_idx
  ON agent_memory_recall_log (chunk_id, created_at);

-- ── AI 用量账本（内部核算 + 失控告警；未来转嫁定价的数据地基）────────────────
-- embedding 与 chat 共用一张表，按 kind 区分。M1 只接 embedding 两个 kind，
-- chat 侧接入另行处理。
-- 归属不变量（review #297 finding 2）：每行必须至少归到一个主体——无主行
-- 对失控告警/分摊核算都是废数据。回填等批处理按块的 scope 分组归账
-- （index-db.ts embedMissing），不允许"批量所以记不到人"。
CREATE TABLE IF NOT EXISTS ai_usage (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       UUID        NULL,
  production_id TEXT        NULL,
  kind          TEXT        NOT NULL,
  model         TEXT        NOT NULL,
  tokens        INTEGER     NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR production_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ai_usage_created_idx ON ai_usage (created_at);
