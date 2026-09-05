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
  -- 剧本设置（舞台指示括号、是否用排练记号）。版式（pageLayout / textLayoutMode）
  -- 已迁进 script_view（migrate-script-view.sql），这里不再存这两个键。
  script_config     JSONB NOT NULL DEFAULT '{}',
  -- 估算页码缓存：{ "<script_view.id>": { "<blockId>": page } }，applyPatchToDB 提交后
  -- 按现存视图各算一份；唯一读者是 lib/db.ts getEstimatedPageMap。
  page_map          JSONB NOT NULL DEFAULT '{}',
  active_version_id TEXT,   -- FK to version(id) added below
  master_view_id    TEXT,   -- FK to script_view(id) added below；主本（页码坐标来源）
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

-- ── Script views（本子）─────────────────────────────────────────────────────────
-- engrave epic #337 / #336：一个演出 N 个本子（导演本 / 舞监本 / 演员分册…），
-- 各自一套版式；production.master_view_id 指定主本。本阶段只有主本一条，但表按
-- 多视图建，免得 D 阶段迁全部存量。page_sequence / template_overrides 是 F / C
-- 阶段的位置预留，缺省值 = 只有内容流、不覆盖模版，当前无读者。

CREATE TABLE IF NOT EXISTS script_view (
  id                 TEXT PRIMARY KEY,
  production_id      TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name               TEXT NOT NULL DEFAULT '',
  page_layout        TEXT NOT NULL DEFAULT 'a4'
                     CHECK (page_layout IN ('a4', 'letter', 'a3-2col', 'tablet-2col')),
  text_layout_mode   TEXT NOT NULL DEFAULT 'center'
                     CHECK (text_layout_mode IN ('center', 'compact')),
  page_sequence      JSONB NOT NULL DEFAULT '[{"kind":"content"}]',
  template_overrides JSONB NOT NULL DEFAULT '{}',
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT script_view_id_production_key UNIQUE (id, production_id)
);

CREATE INDEX IF NOT EXISTS script_view_production_idx ON script_view(production_id, sort_order);

-- Resolve circular FK: production → script_view。复合 FK 让主本在库层只能指向本演出
-- 的视图；无 ON DELETE：主本不可单独删除。
DO $$ BEGIN
  ALTER TABLE production ADD CONSTRAINT production_master_view_id_fkey
    FOREIGN KEY (master_view_id, id) REFERENCES script_view(id, production_id);
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
--
-- 本表是 marker block 的派生读模型（syncSceneVersionsFromMarkersInTx 在同一
-- 事务内重建），不是可独立写入的真相源。场次号（「第一幕」「1-2」）不落库，
-- 由 marker 层级实时生成（buildMarkerLabelIndex）——原 num 列已退役（#159）。
CREATE TABLE IF NOT EXISTS scene_version (
  scene_id          TEXT NOT NULL REFERENCES scene(id),
  version_id        TEXT NOT NULL REFERENCES version(id) ON DELETE CASCADE,
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
  -- 稳定逻辑身份（no FK）。用户可见的一切 cue 引用锚它，不锚行 id——mention 正文、
  -- wiki_entity_link 的 cue 边、/cues?cueId= 深链（#302，migrate-cue-mention-stable-id）。
  cue_id            TEXT NOT NULL,
  start_snapshot_id TEXT,             -- script.id snapshot when anchor was set (no FK)
  end_snapshot_id   TEXT             -- script.id snapshot when anchor was set (no FK)
  -- no UNIQUE (cue_list_id, number): cue is a revision table; the same logical
  -- cue number can have multiple rows across different versions
);

CREATE INDEX IF NOT EXISTS cue_list_idx ON cue(cue_list_id);

-- 引用解析按稳定 id 查（mention-resolve / block-search 都是 cue_id 上的
-- = ANY(...) + DISTINCT ON），没有它就是每次解析全表扫。
CREATE INDEX IF NOT EXISTS cue_stable_id_idx ON cue(cue_id);

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
  was_poc       BOOLEAN     NOT NULL DEFAULT false,
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

-- （task_phase 定义在 phase 表之后——语句顺序即执行顺序）

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
-- W1（add-wiki-library.sql）：文档树=内禀 parent_id；可见性推导
-- （asset 同构）：个人 grant 行 ∨ is_public ∨ dept 分享面 ∨ ∃挂载边:宿主可见，
-- 挂载/分享面永不物化 grant 行（§0.9 负面清单），新建默认隐私。
-- #358 改写 W1 那句「标准树非图」：wiki 行之间仍是标准树（每行只有一个 parent_id），
-- 但**目录树的节点集**从此是「wiki 行 ∪ wiki_alias 行」——同一篇文档出现在多个层级
-- 由多个指向它的别名叶子表达，见下方 wiki_alias。

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- node 树统一（#420）后 wiki 回归**纯文档内容对象**：树位置（parent/sort）与
-- 权限位（is_public/listable）全部活在 node 表的 kind='wiki' 壳节点上
-- （migrate-node-tree.sql；树列备份见 wiki_tree_backup_node_tree）。
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
CREATE INDEX IF NOT EXISTS wiki_mentions_idx   ON wiki USING GIN (mentions);
CREATE INDEX IF NOT EXISTS wiki_title_trgm_idx ON wiki USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS wiki_body_trgm_idx  ON wiki USING GIN (body gin_trgm_ops);

-- 软链接（原 wiki_alias，#358）已随 node 树统一（#420）合入 node 表的
-- kind='link' 节点；#358 的全部不变量（叶子性、无权限列的物理保证、本地可枚举
-- 判据、惰性兜底）以 node 表 CHECK 与 lib/node 判定的形态延续，见 node 表注释。
-- 原表保留为 wiki_alias_backup_node_tree（回滚依据，落稳后单独 DROP）。

-- 交叉引用边（wiki↔任意对象；backlinks/unlinked references/对象侧"相关 wiki"面板的数据基础）。
-- entity 多态无 FK（scene/cue 等 TEXT short id、wiki UUID 存文本），存在性校验在应用层，
-- 悬空边容忍（反向查询只从活宿主页发起）。production_id 反范式=反向查询过滤锚+跨剧组防泄漏。
-- origin：'wiki_body'=正文保存时解析派生（全删全插只清这种）；'manual'=显式建链，重建不得触碰。
-- 边零权限语义：不进任何可见性谓词——标题级列出、点击处由目标页过门（§4.1）。
CREATE TABLE IF NOT EXISTS wiki_entity_link (
  wiki_id       UUID        NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  entity_type   TEXT        NOT NULL,
  entity_id     TEXT        NOT NULL,
  origin        TEXT        NOT NULL DEFAULT 'wiki_body',
  created_by    UUID        NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wiki_id, entity_type, entity_id, origin)
);

CREATE INDEX IF NOT EXISTS wiki_entity_link_entity_idx
  ON wiki_entity_link (production_id, entity_type, entity_id);

-- 自由 tag（必可手写，非受控词表；production 归属经 wiki join）
CREATE TABLE IF NOT EXISTS wiki_tag (
  wiki_id UUID NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (wiki_id, tag)
);

CREATE INDEX IF NOT EXISTS wiki_tag_tag_idx ON wiki_tag (tag);

-- 部门分享面已随 node 树统一（#420）迁为 node_dept_share（树/分享面归 node 域），
-- 见 node 表区段。结构面定式不变：判定时查部门成员，零 sweep，不物化。
-- 方言 v1→v2 迁移的正文备份（migrate-wiki-dialect-v2.sql）。既是回滚依据，也是
-- 「本库是否已迁移」的判据——本迁移是纯 DML 正文改写，没有可供判定的列变化。
-- 迁移落稳后可单独 DROP，但在那之前它是唯一能还原迁移前正文的地方
-- （wiki_revision 只有编辑历史，不含迁移这一次的改写）。
CREATE TABLE IF NOT EXISTS wiki_body_backup_dialect_v2 (
  wiki_id    UUID        PRIMARY KEY REFERENCES wiki(id) ON DELETE CASCADE,
  body       TEXT        NOT NULL,
  taken_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 方言 v1→v2 迁移里 wiki.body 之外那几列的正文备份（agent_memory_chunk.text /
-- comment.body / user_notification.body）。通用形状，行数极少。
CREATE TABLE IF NOT EXISTS dialect_v2_text_backup (
  table_name  TEXT        NOT NULL,
  row_id      TEXT        NOT NULL,
  column_name TEXT        NOT NULL,
  body        TEXT        NOT NULL,
  taken_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, row_id, column_name)
);

-- cue 引用换锚（migrate-cue-mention-stable-id.sql，#302）改写过的正文备份：
-- 把 `/__cm__/cue/<行id>` 平移成 `<稳定 cue_id>` 之前的原文。与 dialect_v2 那张
-- 同形状但独立成表——两次迁移的回滚依据不能互相覆盖。
CREATE TABLE IF NOT EXISTS cue_mention_text_backup (
  table_name  TEXT        NOT NULL,
  row_id      TEXT        NOT NULL,
  column_name TEXT        NOT NULL,
  body        TEXT        NOT NULL,
  taken_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, row_id, column_name)
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
  -- parent 列（create/move 的「新父」）已随 #420 换键为 parent_node_id，
  -- 在 node 表区段以 ALTER 补列（node 定义在本表之后）
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

-- node 树系统配置（原 production_wiki_config，随 #420 改名——锚点泛化为 node 根，
-- 三根列（reports/dramaturgy/assets）在 node 表区段以 ALTER 补列（node 定义在后）。
-- 锚点是普通 node，锚认 id 不认位置，可改名/移动不可删。
CREATE TABLE IF NOT EXISTS production_node_config (
  production_id        TEXT    PRIMARY KEY REFERENCES production(id) ON DELETE CASCADE,
  reports_tree_enabled BOOLEAN NOT NULL DEFAULT true,
  reports_root_title   TEXT    NOT NULL DEFAULT '报告',
  -- 「戏剧构作」（灵感库）系统根：场景侧新建文档的默认落位，也是「构作 · 灵感
  -- 文档」工作区展示的子树。根下可自由建层级/拖拽（#352 拍板）。不做 per-scene
  -- 子目录——scene 易变且 wiki↔scene 是 m:n，归属由 wiki_entity_link manual 边表达
  dramaturgy_tree_enabled BOOLEAN NOT NULL DEFAULT true,
  dramaturgy_root_title   TEXT    NOT NULL DEFAULT '戏剧构作',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- event_report / event_report_note / event_report_read 定义已随 node 树统一
-- （#420）移入 node 表区段——边换键 wiki_id → node_id（「任意 node 可挂载为
-- report」），node 定义在本位置之后。
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

-- ── 审批流程模版（prA，db/add-approval-flow-template.sql）─────────────────────
-- 只存不驱动改为引擎消费（prB）：published 模版是提交时编译快照的来源。
-- 节点结构校验在 lib/approval-flow-template.ts（服务端 create/update 必经）。
-- 定义在 approval_request 之前：flow_template_id 前向引用。
CREATE TABLE IF NOT EXISTS approval_flow_template (
  id             TEXT        PRIMARY KEY,          -- aft_ 前缀 short id（仓库 id 规约）
  production_id  TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  description    TEXT        NOT NULL DEFAULT '',
  resource_scope TEXT        NOT NULL DEFAULT '',  -- v1 展示字符串；范围匹配语义待扩展
  status         TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  nodes          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     UUID        NULL REFERENCES app_user(id)
);

CREATE INDEX IF NOT EXISTS idx_approval_flow_template_production
  ON approval_flow_template (production_id);

-- 单一使用中：编译器语义「该项目有已发布模版？」是单数。
CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_flow_template_published
  ON approval_flow_template (production_id) WHERE status = 'published';

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
  requested_expires_at TIMESTAMPTZ NULL,
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

  -- 模版流实例快照（prB，db/add-approval-flow-snapshot.sql）：
  -- NULL = 阶梯流（存量行与无模版项目），引擎走既有阶梯路径（懒编译不回填）。
  flow_snapshot    JSONB NULL,
  flow_template_id TEXT  NULL REFERENCES approval_flow_template(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ NULL,
  resolved_by     UUID NULL REFERENCES app_user(id),
  granted_at      TIMESTAMPTZ NULL,
  expires_at      TIMESTAMPTZ NULL,

  -- 固定档位写 ttl_duration；自定义日期写 requested_expires_at，二者互斥。
  CONSTRAINT approval_request_ttl_duration_required
    CHECK (grant_type IS DISTINCT FROM 'ttl' OR ttl_duration IS NOT NULL OR requested_expires_at IS NOT NULL),
  CONSTRAINT approval_request_ttl_source_exclusive
    CHECK (ttl_duration IS NULL OR requested_expires_at IS NULL)
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
  -- is_public 已随 #420 迁入 node.is_public（两个 public 位并存必漂移）。语义差
  -- 留在内容面判定：asset 的 public 只免除结构面要求、仍需能力票（lib/asset/perm）
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

-- asset_mount 已随 node 树统一（#420）演化为 node_mount（asset_id → node_id、
-- 化石列清理、六个 mount_type 值退役），定义见 node 表区段。
-- asset_version_rel（资产文件按版本 pin）已随版本退役删除
-- （migrate-version-retire.sql）：文件解析一律 latest-wins。
-- asset_share_token 化石表已删（migrate-node-tree.sql）：分享 token 实现早已
-- 换成无状态 HMAC（lib/asset/share-token.ts），该表全代码零读写。

-- ═══════════════════════════════════════════════════════════════════════════
-- node 树（epic #420）：一棵树承载组织与权限，异构边承载消费关系
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 壳节点模型（飞书式）：树节点是壳（位置+权限），内容对象另存——wiki 表管正文、
-- asset 表管文件与版本。四种 kind：folder / wiki / asset / link。
--
-- 本体规约：
--   · 一个 wiki/asset 只对应一个 node（partial unique 钉死）。
--   · 权限双面：枚举面沿祖先链求交（listable / node_dept_share / 内容域
--     meta@view 预取对撞目标列），实现只有 lib/node/perm.ts 一份；内容面
--     由各内容域判定（canViewWiki / canViewAsset）自持，读 node 的 is_public。
--     grant 行永久键在内容域（'wiki'/uuid、'asset'/id）**不迁**——`*@view`
--     sub 通配天然命中 meta 的零迁移蕴含不能断。
--   · 【硬不变量】边不投枚举票：任何边种不得让节点在树里出现。内容面的
--     挂载让渡＝分享语义（资产挂到可见 scene ⇒ 内容可见，正如 wiki 被分享后
--     父链不可枚举也看不到它在树里的位置，但能读）。
--   · 悬空即删：目标指针全部真 FK CASCADE（asset 删 → node 级联 → node_mount
--     级联；node 删 → link 级联）；读路径仍 join 目标做惰性兜底。
--   · kind='link'（接替 wiki_alias，#358 全部不变量延续）：叶子、无权限语义
--     （CHECK 钉死 listable=true ∧ is_public=false——原「表上无权限列」的物理
--     保证换此形态）、显示名 NULL=跟随目标实时标题、本地可枚举判据不含目标
--     祖先链（别名给的是第二个位置，位置维由自己的父链承担）。
--   · parent_id 的 SET NULL 只是兜底：删除路径由 deleteNode 事务内「子项上移
--     一层」（#352）。锚点（reports/dramaturgy/assets 三根 + event 目录）是
--     无主公共容器：不发 grant 行、is_public=true 防漂根、容器写门豁免。
CREATE TABLE IF NOT EXISTS node (
  id             TEXT        PRIMARY KEY,
  production_id  TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  kind           TEXT        NOT NULL CHECK (kind IN ('folder', 'wiki', 'asset', 'link')),
  parent_id      TEXT        NULL REFERENCES node(id) ON DELETE SET NULL,
  sort_key       TEXT        NULL,
  is_public      BOOLEAN     NOT NULL DEFAULT false,
  listable       BOOLEAN     NOT NULL DEFAULT true,
  wiki_id        UUID        NULL REFERENCES wiki(id)  ON DELETE CASCADE,
  asset_id       TEXT        NULL REFERENCES asset(id) ON DELETE CASCADE,
  link_target_id TEXT        NULL REFERENCES node(id)  ON DELETE CASCADE,
  title          TEXT        NULL,
  created_by     UUID        NULL REFERENCES app_user(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT node_kind_target_check CHECK (
       (kind = 'folder' AND wiki_id IS NULL     AND asset_id IS NULL     AND link_target_id IS NULL     AND title IS NOT NULL)
    OR (kind = 'wiki'   AND wiki_id IS NOT NULL AND asset_id IS NULL     AND link_target_id IS NULL     AND title IS NULL)
    OR (kind = 'asset'  AND wiki_id IS NULL     AND asset_id IS NOT NULL AND link_target_id IS NULL     AND title IS NULL)
    OR (kind = 'link'   AND wiki_id IS NULL     AND asset_id IS NULL     AND link_target_id IS NOT NULL)
  ),
  CONSTRAINT node_link_no_perm_check CHECK (
    kind <> 'link' OR (listable = true AND is_public = false)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS node_wiki_uidx  ON node (wiki_id)  WHERE wiki_id  IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS node_asset_uidx ON node (asset_id) WHERE asset_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS node_link_place_uidx ON node (parent_id, link_target_id) WHERE kind = 'link';
CREATE INDEX IF NOT EXISTS node_production_idx  ON node (production_id);
CREATE INDEX IF NOT EXISTS node_parent_idx      ON node (parent_id);
CREATE INDEX IF NOT EXISTS node_link_target_idx ON node (link_target_id) WHERE link_target_id IS NOT NULL;

-- 部门分享面（接替 wiki_dept_share）。结构面定式：判定时查部门成员，零 sweep。
CREATE TABLE IF NOT EXISTS node_dept_share (
  node_id    TEXT        NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  dept_id    UUID        NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, dept_id)
);

-- 实体目录指针（#420 缺省落点，add-node-entity-dir.sql）：业务实体缺省目录的
-- 惰性 get-or-create 指针。folder title 是实体名副本，解析时惰性跟随。
-- 使用者：script '*'（「剧本」）、cue_root '*'（「Cue」）、cue_list <id>；
-- event 系走 production_event.report_doc_node_id 先例列。
CREATE TABLE IF NOT EXISTS node_entity_dir (
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  node_id       TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (production_id, entity_type, entity_id)
);

-- 简单通用挂载边（原 asset_mount，#420 演化）：业务点 ↔ node 的缺省边种。
-- 挂载边是**关系概念不是一张表**——业务复杂度到了就从本表毕业成专表（如
-- event_report 的三元关系），本表只服务「还没长出个性」的简单挂载。
-- mount_id 多态无 FK（scene/block/cue/comment/event/…的稳定 id），归属校验在
-- 应用层；宿主删除的悬空行由读路径 join 兜底（反向查询只从活宿主页发起）。
-- mount_type='embed'：wiki 正文嵌入的图片资产（宿主 mount_id=wiki uuid，内容面
-- 寻址）——「文档可见⇒图可见」的让渡通道，原 mount_type='wiki' 改名而来。
-- CHECK 白名单是物理保险丝：退役词汇（production/wiki/version/*_snapshot/
-- cue_revision）的漏网写入者当场失败，不静默造半迁移数据。
CREATE TABLE IF NOT EXISTS node_mount (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  mount_type    TEXT NOT NULL,
  mount_id      TEXT NOT NULL,
  mount_aux_id  TEXT,
  created_by    UUID NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT node_mount_type_check CHECK (mount_type IN
    ('scene', 'block', 'cue', 'comment', 'event', 'event_schedule', 'task', 'event_report', 'embed'))
);

CREATE INDEX IF NOT EXISTS node_mount_production_idx ON node_mount (production_id);
CREATE INDEX IF NOT EXISTS node_mount_point_idx      ON node_mount (mount_type, mount_id);
CREATE INDEX IF NOT EXISTS node_mount_node_idx       ON node_mount (node_id);

-- 前文表的 node 列（定义序在 node 之前，此处 ALTER 补列——同 report_doc 旧例）
ALTER TABLE production_node_config ADD COLUMN IF NOT EXISTS reports_root_node_id    TEXT NULL REFERENCES node(id) ON DELETE SET NULL;
ALTER TABLE production_node_config ADD COLUMN IF NOT EXISTS dramaturgy_root_node_id TEXT NULL REFERENCES node(id) ON DELETE SET NULL;
ALTER TABLE production_node_config ADD COLUMN IF NOT EXISTS assets_root_node_id     TEXT NULL REFERENCES node(id) ON DELETE SET NULL;
ALTER TABLE production_event ADD COLUMN IF NOT EXISTS report_doc_node_id TEXT NULL REFERENCES node(id) ON DELETE SET NULL;
ALTER TABLE wiki_proposal    ADD COLUMN IF NOT EXISTS parent_node_id     TEXT NULL REFERENCES node(id) ON DELETE SET NULL;

-- event_report = event↔node 挂载边（id 即边 id；发布是这次挂载的生命周期）。
-- 「任意 node 可挂载为 report」（#420）；node_id 无 ON DELETE=被挂载的节点不可删
-- （deleteNode 的 mounted 守卫 + FK 双保险，与原 wiki_id 语义一致）。
CREATE TABLE IF NOT EXISTS event_report (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  report_type  TEXT NOT NULL DEFAULT 'rehearsal',
  node_id      TEXT NOT NULL REFERENCES node(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS event_report_event_idx ON event_report(event_id);
CREATE INDEX IF NOT EXISTS event_report_node_idx  ON event_report(node_id);

-- event_report_note = report边↔node×dept 挂载边（per-dept 三元关系——
-- 「异构边各自建表」的现成样本）
CREATE TABLE IF NOT EXISTS event_report_note (
  id             TEXT PRIMARY KEY,
  report_id      TEXT NOT NULL REFERENCES event_report(id) ON DELETE CASCADE,
  department_id  UUID NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  node_id        TEXT NOT NULL REFERENCES node(id),
  -- 创建通道（批C C3）：dept=本部门 / wildcard=通配权 / moderator=event 编辑者；
  -- POC 的 ud 门 = dept/<D>/notes@edit|delete 行 ∧ created_via='dept'（导演提的不可被 POC 删）
  created_via    TEXT NOT NULL DEFAULT 'dept' CHECK (created_via IN ('dept', 'wildcard', 'moderator')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_report_note_report_idx ON event_report_note(report_id);
CREATE INDEX IF NOT EXISTS event_report_note_node_idx   ON event_report_note(node_id);

CREATE TABLE IF NOT EXISTS event_report_read (
  report_id TEXT NOT NULL REFERENCES event_report(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  read_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, user_id)
);

-- 迁移备份（migrate-node-tree.sql；回滚依据，落稳后单独 DROP——同
-- wiki_body_backup_dialect_v2 定式）
CREATE TABLE IF NOT EXISTS wiki_tree_backup_node_tree (
  wiki_id   UUID,
  parent_id UUID,
  sort_key  TEXT,
  is_public BOOLEAN,
  listable  BOOLEAN
);
CREATE TABLE IF NOT EXISTS wiki_alias_backup_node_tree (
  id            TEXT        PRIMARY KEY,
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  parent_id     UUID        NULL,
  sort_key      TEXT        NULL,
  target_type   TEXT        NOT NULL DEFAULT 'wiki',
  target_id     TEXT        NOT NULL,
  display_title TEXT        NULL,
  created_by    UUID        NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- ── Milestones & Phases ───────────────────────────────────────────────────────
-- milestone（时间节点，点）与 phase（项目大阶段，区间）平级，无从属关系；
-- 任务=项目小阶段挂 phase。原 task_milestone 边已退役
-- （migrate-drop-task-milestone.sql，退役时全库零数据）。

CREATE TABLE IF NOT EXISTS milestone (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  end_date      DATE NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS milestone_production_idx ON milestone(production_id, end_date);

-- dept_id NULL = production-level；非 NULL = department-specific（仅 kind='dept'，
-- 应用层校验）。部门解散 SET NULL 升级为全局（与 task.department_id 同语义）。
-- 可见性全员（这是 phase 与 blocking task 的根本区别），dept_id 只表达归属与管理权。
-- end_date 可空 = 尾巴未定；甘特图画到轴右缘渐隐。
CREATE TABLE IF NOT EXISTS phase (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  dept_id       UUID REFERENCES production_dept(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  start_date    DATE NOT NULL,
  end_date      DATE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT phase_date_order_check CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS phase_production_idx ON phase(production_id, start_date);

-- phase ↔ milestone 多对多：「首演」这种全局节点可同时收尾多个部门 phase
CREATE TABLE IF NOT EXISTS phase_milestone (
  phase_id     TEXT NOT NULL REFERENCES phase(id) ON DELETE CASCADE,
  milestone_id TEXT NOT NULL REFERENCES milestone(id) ON DELETE CASCADE,
  PRIMARY KEY (phase_id, milestone_id)
);

CREATE INDEX IF NOT EXISTS phase_milestone_milestone_idx ON phase_milestone(milestone_id);

-- Task 阶段关联（0..n；不约束 task 起止 ⊆ phase 区间，前端仅软提示。
-- task 表见 event 域段落；本表因引用 phase 置于其后）
CREATE TABLE IF NOT EXISTS task_phase (
  task_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  phase_id TEXT NOT NULL REFERENCES phase(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, phase_id)
);

CREATE INDEX IF NOT EXISTS task_phase_phase_idx ON task_phase(phase_id);

-- Event 里程碑关联（事件可关注 0..n 个项目里程碑）
CREATE TABLE IF NOT EXISTS event_milestone (
  event_id     TEXT NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  milestone_id TEXT NOT NULL REFERENCES milestone(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, milestone_id)
);

CREATE INDEX IF NOT EXISTS event_milestone_milestone_idx ON event_milestone(milestone_id);

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

-- production_member 新增字段（supervisor_id、status、退出成因三列）
--
-- status 三态终局（#141，migrate-member-exit-states.sql）：
--   active    正常在职
--   suspended 访问权冻结、授权行原样保留 —— 复职零重配
--   exited    已离组，授权真撤，成员行与历史保留
-- #137 埋的 pending_exit / disputed 属于已废弃的退出审批流（方案 A），已退役。
--
-- status_source 分开「他自己退的」与「他被停用了」——结算与署名争议里这是两回事。
-- 它描述当前状态的成因，回到 active 时置回 NULL，故与 status 互为不变式。
ALTER TABLE production_member
  ADD COLUMN IF NOT EXISTS supervisor_id UUID REFERENCES app_user(id) NULL,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS status_source TEXT NULL,
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS status_changed_by UUID NULL REFERENCES app_user(id);

ALTER TABLE production_member
  DROP CONSTRAINT IF EXISTS production_member_status_check;
ALTER TABLE production_member
  ADD CONSTRAINT production_member_status_check
  CHECK (status IN ('active', 'suspended', 'exited'));

ALTER TABLE production_member
  DROP CONSTRAINT IF EXISTS production_member_status_source_value_check;
ALTER TABLE production_member
  ADD CONSTRAINT production_member_status_source_value_check
  CHECK (status_source IS NULL OR status_source IN ('self', 'admin'));

ALTER TABLE production_member
  DROP CONSTRAINT IF EXISTS production_member_status_source_check;
ALTER TABLE production_member
  ADD CONSTRAINT production_member_status_source_check
  CHECK ((status = 'active') = (status_source IS NULL));

-- 成员状态变更审计（#141）。处置行（to_status NOT NULL）真的改了状态；
-- 表态行（to_status IS NULL）只留态度、不动访问权——「不认可此退出」在方案 A 里
-- 是状态 disputed，它不该是状态：不改变任何人能看到什么，只在争议时作证据。
CREATE TABLE IF NOT EXISTS production_member_status_audit (
  id            BIGSERIAL   PRIMARY KEY,
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  action        TEXT        NOT NULL CHECK (action IN (
                              'self_exit', 'suspend', 'restore',
                              'confirm_exit', 'object', 'endorse'
                            )),
  from_status   TEXT        NOT NULL,
  to_status     TEXT        NULL,
  actor_id      UUID        NULL REFERENCES app_user(id),
  note          TEXT        NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pmsa_stance_has_no_target
    CHECK ((action IN ('object', 'endorse')) = (to_status IS NULL))
);

CREATE INDEX IF NOT EXISTS pmsa_member_time_idx
  ON production_member_status_audit (production_id, user_id, created_at DESC);

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
  -- dept = production_dept（批C C3 并表后单一 id 空间）。#327 起它是**部门的唯一
  -- 权限类型**：治理面（建/删/改、成员、POC、权限行，原 org_dept）与 notes 面同挂于此
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
  -- 治理域（批F）：production 根实例（id 恒 '*'）；SENSITIVE 键=owner∨行
  -- （无 admin 旁路）、ROOT 三键=owner-only 代码判定（节点入树行不发）。
  -- 部门类型是 dept（下方批C3 段登记四动词）：org_dept 这个名字已随
  -- migrate-retire-dept-type.sql（#327）退役——它与 dept 本就指同一张
  -- production_dept，分裂是 event_department 并表前的遗留。
  ('production',   'view', 0), ('production',   'create', 0), ('production',   'edit', 0), ('production',   'delete', 0),
  ('member',       'view', 0), ('member',       'create', 0), ('member',       'edit', 0), ('member',       'delete', 0),
  ('producer',     'view', 0), ('producer',     'create', 0), ('producer',     'edit', 0), ('producer',     'delete', 0),
  ('role',         'view', 0), ('role',         'create', 0), ('role',         'edit', 0), ('role',         'delete', 0),
  ('milestone',    'view', 0), ('milestone',    'create', 0), ('milestone',    'edit', 0), ('milestone',    'delete', 0),
  ('phase',        'view', 0), ('phase',        'create', 0), ('phase',        'edit', 0), ('phase',        'delete', 0),
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

-- material 物料台账（add-material-verbs.sql）：四动词。模版发键在先、词汇表
-- 登记在后的线上事故补账——模版 resource_type ⊆ 词汇表由 conventions 测试守护
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('material', 'view', 0), ('material', 'create', 0), ('material', 'edit', 0), ('material', 'delete', 0)
ON CONFLICT DO NOTHING;

-- finance 预算与支出：按 budget / categories / expenses 子面授权，动词仍是 REST 四元组。
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('finance', 'view', 0), ('finance', 'create', 0), ('finance', 'edit', 0), ('finance', 'delete', 0)
ON CONFLICT DO NOTHING;

-- ai AI 用量可见性（#383，add-ai-quota.sql）：只有 view——用量是只读账本，
-- 「改额度」不是权限键能表达的东西（那是兑换码/管理员发放）。
--   node:ai/<prod>/usage@view          项目总览    node:ai/<prod>/usage/members@view  按成员分解
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('ai', 'view', 0)
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

-- （approval_flow_template 表定义已上移到 approval_request 之前——
--   approval_request.flow_template_id 前向引用它，干净库按序重建时必须先建。）

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
-- billed_credits / paid_from（#383，db/add-ai-quota.sql）：
--   1 credit = 1 个 deepseek-v4-flash cache-miss input token 的 peak 单价
--   （$0.44/1M）。裸 token 会被 cache_read 淹没（缓存读只有 1/31 单价），限流
--   必须按成本折算。单价表在 lib/plan.ts，chat 侧的美元数由 provider 层算好。
--   paid_from：这一行由谁买单（档位窗口 / 额外额度 / 豁免）。窗口聚合只 SUM
--   'quota' 行——窗口用量与 extra 余额是两套账，不互相污染。
CREATE TABLE IF NOT EXISTS ai_usage (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        UUID        NULL,
  production_id  TEXT        NULL,
  kind           TEXT        NOT NULL,
  model          TEXT        NOT NULL,
  tokens         INTEGER     NOT NULL,
  billed_credits BIGINT      NOT NULL DEFAULT 0,
  paid_from      TEXT        NOT NULL DEFAULT 'quota',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR production_id IS NOT NULL),
  CONSTRAINT ai_usage_paid_from_check CHECK (paid_from IN ('quota', 'extra', 'exempt'))
);

CREATE INDEX IF NOT EXISTS ai_usage_created_idx            ON ai_usage (created_at);
CREATE INDEX IF NOT EXISTS ai_usage_user_created_idx       ON ai_usage (user_id, created_at);
CREATE INDEX IF NOT EXISTS ai_usage_production_created_idx ON ai_usage (production_id, created_at);

-- ── 等级体系（#280，db/add-plan.sql，付费功能地基）─────────────────────────────
-- user_plan 无行 = 普通用户（不能建项目）；production_plan 无行 = free 档。
-- tier → limit 映射是代码常量（lib/plan.ts），库里只存档名。
-- billing_exempt = 项目级豁免（「特邀项目」），写点仅管理员改库 + grants_exempt 码；
-- internal 档 owner 的豁免则在计费时按当前 owner 推导，不物化到这里。豁免 ≠ 不记账。
-- plan_code 无创建界面：管理员手工 INSERT。

CREATE TABLE IF NOT EXISTS user_plan (
  user_id    UUID        PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  tier       TEXT        NOT NULL,
  source     TEXT        NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS production_plan (
  production_id  TEXT        PRIMARY KEY REFERENCES production(id) ON DELETE CASCADE,
  tier           TEXT        NOT NULL,
  billing_exempt BOOLEAN     NOT NULL DEFAULT false,
  exempt_note    TEXT        NULL,
  source         TEXT        NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- kind='ai_credits'（#383）：AI 额外额度码，不授档位（grants_tier IS NULL）、
-- 只加 grants_credits。「想多用就买」复用这张表——兑换流水/次数/过期/暴破限流全现成。
CREATE TABLE IF NOT EXISTS plan_code (
  code           TEXT        PRIMARY KEY,
  kind           TEXT        NOT NULL,
  grants_tier    TEXT        NULL,
  grants_exempt  BOOLEAN     NOT NULL DEFAULT false,
  grants_credits BIGINT      NOT NULL DEFAULT 0,
  exempt_note    TEXT        NULL,
  max_uses       INTEGER     NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  used_count     INTEGER     NOT NULL DEFAULT 0,
  expires_at     TIMESTAMPTZ NULL,
  note           TEXT        NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT plan_code_kind_check   CHECK (kind IN ('user_upgrade', 'production_upgrade', 'ai_credits')),
  -- 两列双向锁死在 kind 上：无创建界面、全靠手工 INSERT 的表，最该挡掉的是
  -- 「插进去不报错但不生效」——升档码带 credits 会被静默忽略，额度码 credits=0
  -- 是一张兑了等于没兑的码。
  CONSTRAINT plan_code_grants_check CHECK (
    (kind = 'ai_credits') = (grants_tier IS NULL)
    AND (kind = 'ai_credits') = (grants_credits > 0)
  )
);

-- 额外额度（#383）：余额型，不随日/周窗口重置；窗口两闸都满之后才动它。
-- remaining 允许为负——判定在 run 开始处做一次、run 内不打断，所以最后一次
-- 扣款可能扣穿；透支上限就是单个 run 的量（lib/plan.ts RUN_CREDIT_HARD_CAP）。
CREATE TABLE IF NOT EXISTS ai_credit_grant (
  id         TEXT        PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  credits    BIGINT      NOT NULL CHECK (credits > 0),
  remaining  BIGINT      NOT NULL,
  source     TEXT        NULL,
  note       TEXT        NULL,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_credit_grant_user_idx ON ai_credit_grant (user_id, expires_at);

CREATE TABLE IF NOT EXISTS plan_code_redemption (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          TEXT        NOT NULL REFERENCES plan_code(code) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  production_id TEXT        NULL REFERENCES production(id) ON DELETE CASCADE,
  redeemed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plan_code_redemption_code_idx ON plan_code_redemption (code);

-- ── 注册邀请制（db/add-registration-gate.sql，测试期收口「登录即注册」）────────
-- 开关 = 环境变量 REGISTRATION_INVITE_ONLY；正当性判定见 lib/registration-gate.ts。
-- 两张登记表均无创建界面：管理员手工 INSERT。

CREATE TABLE IF NOT EXISTS registration_code (
  code       TEXT        PRIMARY KEY,
  max_uses   INTEGER     NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  used_count INTEGER     NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NULL,
  note       TEXT        NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registration_code_redemption (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT        NOT NULL REFERENCES registration_code(code) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  email       TEXT        NOT NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registration_code_redemption_code_idx
  ON registration_code_redemption (code);

CREATE TABLE IF NOT EXISTS registration_email (
  email      TEXT        PRIMARY KEY,  -- 存小写
  note       TEXT        NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── AI 运行时自建：会话/transcript/run/审批/提问（add-agent-runtime.sql，#367）──────

-- ── 会话 ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_session (
  id              TEXT        PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- NULL = 个人会话（跨全部制作的 my.* 语义）；非 NULL = 关联制作的会话
  production_id   TEXT        NULL REFERENCES production(id) ON DELETE CASCADE,
  title           TEXT        NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ NULL,
  archived_at     TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS agent_session_user_idx
  ON agent_session (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS agent_session_production_idx
  ON agent_session (production_id)
  WHERE production_id IS NOT NULL;

COMMENT ON TABLE agent_session IS
  'AI 会话（#367 自建运行时）。user_id/production_id 是一等列——网关时代只在 sessionKey 里编码。';

-- ── transcript：append-only 会话树条目 ──────────────────────────────────────
-- payload = 完整 SessionTreeEntry JSON（含 id/parentId/timestamp/type 与各类型字段）。
-- entry_id/parent_id/type 抽成列只为查询与约束，语义真相在 payload。
-- seq 是会话内单调追加序，同时是断线重连"since=seq"重放游标。
CREATE TABLE IF NOT EXISTS agent_session_entry (
  session_id  TEXT        NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
  seq         INTEGER     NOT NULL,
  entry_id    TEXT        NOT NULL,
  parent_id   TEXT        NULL,
  type        TEXT        NOT NULL,
  payload     JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq),
  UNIQUE (session_id, entry_id)
);

COMMENT ON TABLE agent_session_entry IS
  'agent-core SessionTreeEntry 逐条落行（append-only）。模型上下文由 agent-core 按 leaf→root 重建，DB 不解释语义。';

-- ── run：一轮执行的生命周期与执行者租约 ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_run (
  id                TEXT        PRIMARY KEY,
  session_id        TEXT        NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
  status            TEXT        NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'awaiting_approval', 'awaiting_answer',
                                        'completed', 'aborted', 'failed', 'interrupted')),
  -- 执行者租约（§4.4）：owner = runner 进程标识；heartbeat_at 每 5s 更新，
  -- 超 30s 无心跳视为孤儿，由存活的 runner 接管恢复。防两个进程同时跑同一 run。
  owner             TEXT        NULL,
  heartbeat_at      TIMESTAMPTZ NULL,
  -- 发起本轮时用户所在页面（PAGE_LABELS 的 pageKey）——温层工具面/知识节点依据
  page_key          TEXT        NULL,
  model             TEXT        NULL,
  input_tokens      INTEGER     NOT NULL DEFAULT 0,
  output_tokens     INTEGER     NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER     NOT NULL DEFAULT 0,
  error             TEXT        NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS agent_run_session_idx
  ON agent_run (session_id, started_at DESC);
-- 孤儿扫描：启动/巡检时找 running 且心跳过期的 run
CREATE INDEX IF NOT EXISTS agent_run_active_idx
  ON agent_run (status, heartbeat_at)
  WHERE status IN ('running', 'awaiting_approval', 'awaiting_answer');

-- ── 审批：写工具的确认门（进程内 await 表状态，重启后从表续）─────────────────
CREATE TABLE IF NOT EXISTS agent_approval (
  id           TEXT        PRIMARY KEY,
  run_id       TEXT        NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  session_id   TEXT        NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
  tool_call_id TEXT        NOT NULL,
  tool         TEXT        NOT NULL,
  args         JSONB       NOT NULL,           -- 全文，不再受网关 512 字符约束
  preview      JSONB       NOT NULL DEFAULT '{}', -- 卡片结构（title/description/severity/hasPermission/反解体…）
  status       TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'allowed', 'denied', 'expired', 'cancelled')),
  decision     TEXT        NULL,               -- allow-once / deny（曾预留 allow-always，未实现已摘）
  reason       TEXT        NULL,               -- 拒绝理由，回给模型
  resolved_by  UUID        NULL REFERENCES app_user(id) ON DELETE SET NULL,
  -- 批准后工具真正开始执行的时刻：重启恢复时区分"批了没跑"（可跑）与
  -- "跑到一半"（副作用未知，不盲重放）
  executed_at  TIMESTAMPTZ NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS agent_approval_pending_idx
  ON agent_approval (status, expires_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS agent_approval_run_idx
  ON agent_approval (run_id);

-- ── ask_user：模型向用户提问（#290 在自建运行时里就是一个 await 的工具）───────
CREATE TABLE IF NOT EXISTS agent_question (
  id           TEXT        PRIMARY KEY,
  run_id       TEXT        NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  session_id   TEXT        NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
  tool_call_id TEXT        NOT NULL,
  payload      JSONB       NOT NULL,           -- questions[]（形态对齐 stream-reducer 的 QuestionInfo）
  answer       JSONB       NULL,
  status       TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'answered', 'cancelled', 'expired')),
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS agent_question_pending_idx
  ON agent_question (status, expires_at)
  WHERE status = 'pending';

-- ── 事件：前端可见的 StreamLine 逐条落行 + NOTIFY 分发 ──────────────────────
-- 观看者与执行者解耦（§4.4 ③）：runner 写行 + pg_notify('agent_events')，next 的
-- SSE 端点 LISTEN 后按 (session_id, seq) 取行；断线重连 since=seq 直接重放。
-- delta 行在执行侧做时间窗合并（累计值语义，合并无损），run 结束后可清理 delta 只留终态。
CREATE TABLE IF NOT EXISTS agent_event (
  session_id TEXT        NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
  seq        BIGINT      NOT NULL,
  run_id     TEXT        NULL,
  line       JSONB       NOT NULL,   -- lib/agent-gateway/stream-reducer.ts 的 StreamLine
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);


-- ── AI 写操作 diff 审计（db/add-agent-mutation.sql）：只读账本，无撤销列 ──
CREATE TABLE IF NOT EXISTS agent_mutation (
  id            TEXT        PRIMARY KEY,
  run_id        TEXT        NULL REFERENCES agent_run(id) ON DELETE SET NULL,
  session_id    TEXT        NULL REFERENCES agent_session(id) ON DELETE SET NULL,
  user_id       UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  production_id TEXT        NULL REFERENCES production(id) ON DELETE CASCADE,
  tool          TEXT        NOT NULL,           -- 注册表 mcpName（production.wiki_propose_update 等）
  tool_call_id  TEXT        NOT NULL,
  scope         TEXT        NOT NULL,           -- 与 mutates 声明同源：wiki / scene / character / instructions.*
  entity_id     TEXT        NULL,               -- 实体 id；域级变更（无具体实体）为 NULL
  action        TEXT        NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  label         TEXT        NULL,               -- 实体的人话名（标题/名称），渲染用，随快照一起定格
  summary       TEXT        NULL,               -- 模型在参数里给的一句话意图（args.summary）
  before        JSONB       NULL,               -- 写前快照（created 为 NULL）
  after         JSONB       NULL,               -- 写后快照（deleted 为 NULL）
  changes       JSONB       NOT NULL DEFAULT '[]', -- [{field, from?, to?, added?, removed?}]
  unattended    BOOLEAN     NOT NULL DEFAULT false, -- 无人值守（定时任务）写的
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_mutation_production_idx
  ON agent_mutation (production_id, created_at DESC)
  WHERE production_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_mutation_user_idx
  ON agent_mutation (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_mutation_run_idx
  ON agent_mutation (run_id)
  WHERE run_id IS NOT NULL;

COMMENT ON TABLE agent_mutation IS
  'AI 写操作的 diff 审计（只读账本，无撤销列）。每次写工具真正改了东西才落行；before/after 由域读取器定形。';

-- ── AI 定时任务（db/add-agent-schedule.sql）：runner 节拍认领 → 以创建者身份开新会话跑 run ──
CREATE TABLE IF NOT EXISTS agent_schedule (
  id                    TEXT        PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- NULL = 个人任务（my.* 语义）；非 NULL = 制作任务，触发前查成员资格与档位
  production_id         TEXT        NULL REFERENCES production(id) ON DELETE CASCADE,
  name                  TEXT        NOT NULL,
  prompt                TEXT        NOT NULL,           -- 每次触发作为用户消息送入的任务指令
  schedule              JSONB       NOT NULL,           -- {kind:'at',at} | {kind:'cron',expr,tz} | {kind:'every',everyMs}
  allowed_tools         TEXT[]      NOT NULL DEFAULT '{}', -- 允许无人值守直接写的工具 mcpName（须同时是注册表 unattended=allow）
  page_key              TEXT        NULL,               -- 创建时所在页面：温层工具面跟着来
  status                TEXT        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'paused', 'done')),
  paused_reason         TEXT        NULL,               -- 系统暂停的原因（不再是成员 / 档位未开 AI…）；人工暂停为 NULL
  next_fire_at          TIMESTAMPTZ NULL,               -- active 时非空；done/paused 时保留最后计划值
  last_fired_at         TIMESTAMPTZ NULL,
  last_run_id           TEXT        NULL REFERENCES agent_run(id) ON DELETE SET NULL,
  last_summary          TEXT        NULL,               -- 上次运行的结果摘要（≤1k，下次触发注入）
  fire_count            INTEGER     NOT NULL DEFAULT 0,
  max_fires             INTEGER     NULL,               -- 触发满即 done
  expires_at            TIMESTAMPTZ NULL,               -- 到期即 done
  -- 认领租约（同 agent_run.owner/heartbeat 的思路）：多实例 / 重启不重复触发
  lease_owner           TEXT        NULL,
  lease_until           TIMESTAMPTZ NULL,
  created_by_session_id TEXT        NULL REFERENCES agent_session(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_schedule_due_idx
  ON agent_schedule (next_fire_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS agent_schedule_user_idx
  ON agent_schedule (user_id, created_at DESC);

COMMENT ON TABLE agent_schedule IS
  'AI 定时任务。runner 节拍认领到期行 → 以创建者身份开新会话跑一次 run → 结果通知创建者。权限实时查、不快照。';

-- 触发出的会话 / run / 写审计都挂回任务：会话列表可标 ⏰、通知可列改动清单、审计页可按任务查
ALTER TABLE agent_session ADD COLUMN IF NOT EXISTS schedule_id TEXT NULL REFERENCES agent_schedule(id) ON DELETE SET NULL;
ALTER TABLE agent_run ADD COLUMN IF NOT EXISTS schedule_id TEXT NULL REFERENCES agent_schedule(id) ON DELETE SET NULL;
ALTER TABLE agent_mutation ADD COLUMN IF NOT EXISTS schedule_id TEXT NULL REFERENCES agent_schedule(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS agent_run_schedule_idx
  ON agent_run (schedule_id, started_at DESC)
  WHERE schedule_id IS NOT NULL;
-- 声明的两个访问面都要索引（AI review #399）：会话列表标 ⏰ / 触发会话自动归档扫描；审计页按任务查
CREATE INDEX IF NOT EXISTS agent_session_schedule_idx
  ON agent_session (schedule_id)
  WHERE schedule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_mutation_schedule_idx
  ON agent_mutation (schedule_id, created_at DESC)
  WHERE schedule_id IS NOT NULL;

-- ── wiki 协作广播出站箱（db/add-wiki-collab-outbox.sql）──
CREATE TABLE IF NOT EXISTS wiki_collab_outbox (
  id         BIGSERIAL   PRIMARY KEY,
  origin     TEXT        NOT NULL,   -- 发布进程标识 host:pid
  topic      TEXT        NOT NULL,   -- wikiId 或 library:<productionId>
  frame      TEXT        NOT NULL,   -- 原样的 SSE 帧文本
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wiki_collab_outbox_created_idx ON wiki_collab_outbox (created_at);

-- ── 头像上传审计账本（db/add-avatar-upload-audit.sql，PR #419 孤儿对象对策）──
-- presign 即记账、提交标记 committed、清旧标记 deleted；孤儿 = 两者皆空的过期行，手动清理。
CREATE TABLE IF NOT EXISTS avatar_upload_audit (
  id           TEXT        PRIMARY KEY,   -- ava_ 前缀 short id（仓库 id 规约）
  r2_key       TEXT        NOT NULL,
  kind         TEXT        NOT NULL CHECK (kind IN ('user', 'production')),
  subject_id   TEXT        NOT NULL,      -- kind=user 时为 app_user.id，production 时为 production.id
  uploader_id  UUID        NOT NULL REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at TIMESTAMPTZ,
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_avatar_upload_audit_r2_key
  ON avatar_upload_audit (r2_key);
CREATE INDEX IF NOT EXISTS idx_avatar_upload_audit_orphan
  ON avatar_upload_audit (created_at)
  WHERE committed_at IS NULL AND deleted_at IS NULL;
