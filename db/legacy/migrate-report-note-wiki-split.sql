-- 批C 前置（PR-C1）：report/note 本体与关系拆分——wiki 文档库的第一天。
--
-- 本体论（用户设计定稿）：
--   wiki         = 内容实体（未来独立文档库的表；命名跟飞书）
--   event_report = event↔wiki 挂载边（id 即边 id，保持现值——URL/FK/通知稳定）
--   event_report_note = report边↔wiki×dept 挂载边（note 的 per-dept 联合关系）
--   wiki_comment = 内容评论（原 event_report_reply，评论归内容实体）
--
-- 自足守卫：全部 IF NOT EXISTS / IF EXISTS，可安全重复执行。
-- 零权限变化：纯本体论修复，行为保真（PR-C2 才做权限迁移）。

BEGIN;

-- ── 1. wiki 实体表 ────────────────────────────────────────────────────────────
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

-- ── 2. report 内容 → wiki，边表挂 wiki_id ─────────────────────────────────────
ALTER TABLE event_report ADD COLUMN IF NOT EXISTS wiki_id UUID NULL REFERENCES wiki(id);

-- 逐行搬迁（体量小，正确性优先；幂等）
DO $$
DECLARE r RECORD; new_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'event_report' AND column_name = 'body') THEN
    FOR r IN SELECT er.id, er.title, er.body, er.mentions, er.created_by,
                    er.created_at, er.updated_at, pe.production_id
             FROM event_report er
             JOIN production_event pe ON pe.id = er.event_id
             WHERE er.wiki_id IS NULL
    LOOP
      INSERT INTO wiki (production_id, title, body, mentions, created_by, created_at, updated_at)
      VALUES (r.production_id, r.title, r.body, COALESCE(r.mentions, '[]'::jsonb),
              r.created_by, r.created_at, r.updated_at)
      RETURNING id INTO new_id;
      UPDATE event_report SET wiki_id = new_id WHERE id = r.id;
    END LOOP;
  END IF;
END $$;

-- ── 3. note 内容 → wiki ───────────────────────────────────────────────────────
ALTER TABLE event_report_note ADD COLUMN IF NOT EXISTS wiki_id UUID NULL REFERENCES wiki(id);
ALTER TABLE event_report_note ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
DECLARE r RECORD; new_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'event_report_note' AND column_name = 'content') THEN
    FOR r IN SELECT n.id, n.content, n.mentions, n.author_user_id,
                    n.created_at, n.updated_at, pe.production_id
             FROM event_report_note n
             JOIN event_report er ON er.id = n.report_id
             JOIN production_event pe ON pe.id = er.event_id
             WHERE n.wiki_id IS NULL
    LOOP
      INSERT INTO wiki (production_id, title, body, mentions, created_by, created_at, updated_at)
      VALUES (r.production_id, NULL, r.content, COALESCE(r.mentions, '[]'::jsonb),
              r.author_user_id, r.created_at, r.updated_at)
      RETURNING id INTO new_id;
      UPDATE event_report_note SET wiki_id = new_id WHERE id = r.id;
    END LOOP;
  END IF;
END $$;

-- ── 4. replies → wiki_comment（parent: report→报告的 wiki；note→note 的 wiki）──
DO $$
DECLARE r RECORD; target UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'event_report_reply') THEN
    FOR r IN SELECT * FROM event_report_reply ORDER BY created_at
    LOOP
      IF r.parent_type = 'note' THEN
        SELECT wiki_id INTO target FROM event_report_note WHERE id = r.parent_id;
      ELSE
        SELECT wiki_id INTO target FROM event_report WHERE id = r.report_id;
      END IF;
      IF target IS NOT NULL THEN
        INSERT INTO wiki_comment (wiki_id, user_id, author_name, content, mentions, created_at)
        VALUES (target, r.user_id, r.author_name, r.content, COALESCE(r.mentions, '[]'::jsonb), r.created_at);
      END IF;
    END LOOP;
    DROP TABLE event_report_reply;
  END IF;
END $$;

-- ── 5. 收紧与去列 ─────────────────────────────────────────────────────────────
ALTER TABLE event_report ALTER COLUMN wiki_id SET NOT NULL;
ALTER TABLE event_report_note ALTER COLUMN wiki_id SET NOT NULL;

ALTER TABLE event_report DROP COLUMN IF EXISTS title;
ALTER TABLE event_report DROP COLUMN IF EXISTS body;
ALTER TABLE event_report DROP COLUMN IF EXISTS mentions;
ALTER TABLE event_report DROP COLUMN IF EXISTS created_by;
ALTER TABLE event_report_note DROP COLUMN IF EXISTS content;
ALTER TABLE event_report_note DROP COLUMN IF EXISTS author_name;
ALTER TABLE event_report_note DROP COLUMN IF EXISTS author_user_id;
ALTER TABLE event_report_note DROP COLUMN IF EXISTS mentions;

COMMIT;
