-- wiki 默认文档树：存量归位（2026-08-16 拍板修订——存量也迁）。
--
-- 不迁的后果：老报告 wiki 全部堆在文档树根部（W3 起 owner 可见），新报告进
-- 报告/<event>/，同一 event 的报告分裂两处，owner 视图问题只解决一半。
--
-- 归位规则（与运行时 ensureReportTreeAnchors / createEventReport 同构）：
--   有报告的 production → production_wiki_config 行 + 「报告」根目录文档（公开）
--   有报告的 event     → 「<event 标题>」目录文档（公开，挂根下，回写锚点列）
--   parent 为空的存量 report wiki → 挂事件目录（按边 created_at 序）
--   title 为空的存量 note wiki   → 赋题「<部门> · 备注」+ 挂其报告 wiki 下
--
-- 尊重显式关闭（config 存在且 enabled=false 的 production 跳过）；
-- 已被人为归位（parent 非空）的 wiki 不动。幂等可重跑。
--
-- 跨 commit 自足守卫（add-wiki-library.sql / add-wiki-default-tree.sql 镜像）：

CREATE EXTENSION IF NOT EXISTS pg_trgm;
ALTER TABLE wiki ADD COLUMN IF NOT EXISTS parent_id UUID NULL REFERENCES wiki(id) ON DELETE SET NULL;
ALTER TABLE wiki ADD COLUMN IF NOT EXISTS sort_key  TEXT NULL;
ALTER TABLE wiki ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS production_wiki_config (
  production_id        TEXT    PRIMARY KEY REFERENCES production(id) ON DELETE CASCADE,
  reports_tree_enabled BOOLEAN NOT NULL DEFAULT true,
  reports_root_title   TEXT    NOT NULL DEFAULT '报告',
  reports_root_wiki_id UUID    NULL REFERENCES wiki(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE production_event
  ADD COLUMN IF NOT EXISTS report_doc_wiki_id UUID NULL REFERENCES wiki(id) ON DELETE SET NULL;

DO $$
DECLARE
  p RECORD; e RECORD; r RECORD; n RECORD;
  v_root UUID; v_doc UUID;
  ek INT; rk INT; nk INT;
  last_report TEXT;
BEGIN
  FOR p IN
    SELECT DISTINCT pe.production_id
    FROM event_report er JOIN production_event pe ON pe.id = er.event_id
    ORDER BY pe.production_id
  LOOP
    -- 尊重显式关闭
    PERFORM 1 FROM production_wiki_config c
     WHERE c.production_id = p.production_id AND NOT c.reports_tree_enabled;
    IF FOUND THEN CONTINUE; END IF;

    INSERT INTO production_wiki_config (production_id)
    VALUES (p.production_id) ON CONFLICT DO NOTHING;

    SELECT reports_root_wiki_id INTO v_root
    FROM production_wiki_config WHERE production_id = p.production_id;
    IF v_root IS NULL THEN
      INSERT INTO wiki (production_id, title, is_public, sort_key)
      SELECT p.production_id, c.reports_root_title, true, 'i000000000'
      FROM production_wiki_config c WHERE c.production_id = p.production_id
      RETURNING id INTO v_root;
      UPDATE production_wiki_config
         SET reports_root_wiki_id = v_root, updated_at = now()
       WHERE production_id = p.production_id;
    END IF;

    ek := 0;
    FOR e IN
      SELECT pe.id, pe.title, pe.report_doc_wiki_id
      FROM production_event pe
      WHERE pe.production_id = p.production_id
        AND EXISTS (SELECT 1 FROM event_report er WHERE er.event_id = pe.id)
      ORDER BY pe.start_time NULLS LAST, pe.created_at
    LOOP
      ek := ek + 1;
      v_doc := e.report_doc_wiki_id;
      IF v_doc IS NULL THEN
        INSERT INTO wiki (production_id, title, is_public, parent_id, sort_key)
        VALUES (p.production_id, e.title, true, v_root, 'e' || lpad(ek::text, 9, '0'))
        RETURNING id INTO v_doc;
        UPDATE production_event SET report_doc_wiki_id = v_doc WHERE id = e.id;
      END IF;

      rk := 0;
      FOR r IN
        SELECT er.wiki_id
        FROM event_report er JOIN wiki w ON w.id = er.wiki_id
        WHERE er.event_id = e.id AND w.parent_id IS NULL
        ORDER BY er.created_at
      LOOP
        rk := rk + 1;
        UPDATE wiki
           SET parent_id = v_doc, sort_key = 'e' || lpad(rk::text, 9, '0'), updated_at = now()
         WHERE id = r.wiki_id;
      END LOOP;

      -- note 赋题+归位：独立扫描（不依赖其报告本次是否被归位，幂等补漏）
      last_report := NULL; nk := 0;
      FOR n IN
        SELECT ern.wiki_id, ern.report_id, er.wiki_id AS report_wiki_id, pd.name AS dept_name
        FROM event_report_note ern
        JOIN event_report er ON er.id = ern.report_id AND er.event_id = e.id
        JOIN production_dept pd ON pd.id = ern.department_id
        JOIN wiki w2 ON w2.id = ern.wiki_id
        WHERE w2.title IS NULL
        ORDER BY ern.report_id, ern.created_at
      LOOP
        IF last_report IS DISTINCT FROM n.report_id THEN nk := 0; last_report := n.report_id; END IF;
        nk := nk + 1;
        UPDATE wiki
           SET title = n.dept_name || ' · 备注',
               parent_id = n.report_wiki_id,
               sort_key = 'e' || lpad(nk::text, 9, '0'),
               updated_at = now()
         WHERE id = n.wiki_id;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;
