-- ═══════════════════════════════════════════════════════════════════════════
-- node 树统一·第一批原子迁移（epic #420）
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 设计定谳：docs/node-tree-design-2026-09-04.md。本迁移一次性完成「树化主体 +
-- 挂载边迁移」——两者互相依赖必须原子落地（边指 node_id 需壳节点先存在；壳存在
-- 而边仍指 asset_id 则两套寻址并存，都是半迁移态）。
--
-- 迁移内容（2026-09-04 拍板）：
--   1. wiki 全量生成 kind='wiki' 壳节点，树列（parent_id/sort_key/is_public/
--      listable）迁入 node 后从 wiki 删除（备份表 wiki_tree_backup_node_tree）。
--   2. wiki_alias → kind='link' 节点；原表改名 wiki_alias_backup_node_tree 保留
--      （回滚依据，落稳后单独 DROP）。
--   3. asset 全量生成 kind='asset' 壳节点：canonical 位置 = 最早的带 folder_path
--      的 production mount 之链叶（无则「资产」根）；listable = 是否有 production
--      mount（原「根共享区」语义由树可枚举性接管）；asset.is_public 迁入 node。
--      folder_path 按 '/' 展开为真实 folder 节点链，此后 folder_path 概念消亡。
--   4. mount 值转译：block_snapshot→block（经 script_version.snapshot_id→block_id）、
--      cue_revision→cue（经 cue_version→cue.cue_id 稳定 id）——版本纪律：挂载即对
--      最新状态的挂载；'version'/'scene_snapshot' 零写入者直接清除；'wiki'→'embed'
--      （嵌入边改名，「文档可见⇒图可见」语义一字不动）；'production' 删除（已被
--      listable 接管）。转译后同键去重保最早。
--   5. asset_mount → node_mount：asset_id 换 node_id（FK CASCADE）；删化石列
--      folder_path/mount_mode/version_resolved；mount_type CHECK 白名单=物理保险丝
--      （漏网的旧词写入者当场炸 500 而非静默半迁移）。mount_aux_id 保留。
--   6. report/note 边换键：event_report / event_report_note 的 wiki_id → node_id
--      （「任意 node 可挂载为 report」）。无 ON DELETE：被挂载的节点不可删，
--      与原 wiki_id 的 FK 语义一致。
--   7. 锚点泛化：production_wiki_config → production_node_config，三根列换
--      *_node_id（reports/dramaturgy/assets）；production_event.report_doc_wiki_id
--      → report_doc_node_id；wiki_proposal.parent_wiki_id → parent_node_id
--      （唯一混进树语义的内容域列）。
--   8. wiki_dept_share → node_dept_share（树/分享面归 node 域）。
--   9. asset_share_token 化石表删除（实现早已换 lib/asset/share-token.ts 无状态
--      HMAC，全代码零读写）。
--
-- 不迁移的：grant 三表（production_member_grant / resource_person_manage /
-- production_dept_permission）**一行不动**——权限行永久键在内容域（'wiki'/uuid、
-- 'asset'/id），枚举面在应用层预取后对撞 node 的目标列。`*@view` sub 通配天然
-- 命中 meta 的零迁移蕴含不能断。
--
-- 自足守卫：幂等，可重复执行；镜像 add-node-tree.sql 全部 DDL。
-- 数据迁移总闸 = wiki 表仍有 parent_id 列（旧结构判据），已迁库整段跳过。

BEGIN;

-- ── §0 自足守卫：镜像 add-node-tree.sql ─────────────────────────────────────

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
CREATE TABLE IF NOT EXISTS node_dept_share (
  node_id    TEXT        NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  dept_id    UUID        NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, dept_id)
);

-- ── §1 结构性前置 DDL（幂等）────────────────────────────────────────────────

-- 1a. config 表改名（消费者仅 lib/wiki 树面一处，改名边际成本≈0；三根列都要换
--     类型翻译值，本来就是真 migration）
DO $$ BEGIN
  IF to_regclass('public.production_wiki_config') IS NOT NULL
     AND to_regclass('public.production_node_config') IS NULL THEN
    ALTER TABLE production_wiki_config RENAME TO production_node_config;
  END IF;
END $$;

-- 1b. 新列（node id 一律 TEXT；锚点列 SET NULL=锚被删后懒建重生，同旧语义；
--     report/note 边无 ON DELETE=被挂载不可删，同旧 wiki_id 语义）
ALTER TABLE production_node_config ADD COLUMN IF NOT EXISTS reports_root_node_id    TEXT NULL REFERENCES node(id) ON DELETE SET NULL;
ALTER TABLE production_node_config ADD COLUMN IF NOT EXISTS dramaturgy_root_node_id TEXT NULL REFERENCES node(id) ON DELETE SET NULL;
ALTER TABLE production_node_config ADD COLUMN IF NOT EXISTS assets_root_node_id     TEXT NULL REFERENCES node(id) ON DELETE SET NULL;
ALTER TABLE production_event  ADD COLUMN IF NOT EXISTS report_doc_node_id TEXT NULL REFERENCES node(id) ON DELETE SET NULL;
ALTER TABLE wiki_proposal     ADD COLUMN IF NOT EXISTS parent_node_id     TEXT NULL REFERENCES node(id) ON DELETE SET NULL;
ALTER TABLE event_report      ADD COLUMN IF NOT EXISTS node_id TEXT NULL REFERENCES node(id);
ALTER TABLE event_report_note ADD COLUMN IF NOT EXISTS node_id TEXT NULL REFERENCES node(id);
DO $$ BEGIN
  IF to_regclass('public.asset_mount') IS NOT NULL THEN
    ALTER TABLE asset_mount ADD COLUMN IF NOT EXISTS node_id TEXT NULL;
  END IF;
END $$;

-- ── §2 数据迁移（总闸：wiki.parent_id 列存在＝旧结构）───────────────────────
-- plpgsql 语句到达时才做语义解析，已迁库在总闸处 RETURN，引用旧列的语句不会被
-- 求值——整段天然幂等。deterministic id（'nd_'+md5 前 14 位）让重复执行的
-- INSERT 全部撞唯一约束吞掉。

DO $$
DECLARE
  r        RECORD;
  seg      TEXT;
  path_acc TEXT;
  fid      TEXT;
  parent   TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'wiki' AND column_name = 'parent_id') THEN
    RETURN;  -- 已迁移
  END IF;

  -- 2.1 wiki → node（全量，含 note 的 title IS NULL 行——1:1 规约无例外；
  --     「库面不显示无题 wiki」的过滤职责移交 listNodeTreeFor 的 join）
  INSERT INTO node (id, production_id, kind, sort_key, is_public, listable, wiki_id, created_by, created_at)
  SELECT 'nd_' || substr(md5('wiki:' || w.id::text), 1, 14), w.production_id, 'wiki',
         w.sort_key, w.is_public, w.listable, w.id, w.created_by, w.created_at
  FROM wiki w
  ON CONFLICT DO NOTHING;

  -- 2.2 parent 链回填（wiki uuid → 对应 node id 的翻译，两遍法第二遍）
  UPDATE node n SET parent_id = p.id
  FROM wiki w JOIN node p ON p.wiki_id = w.parent_id
  WHERE n.wiki_id = w.id AND w.parent_id IS NOT NULL AND n.parent_id IS NULL;

  -- 2.3 wiki_alias → kind='link'（目标解析不到的悬空别名丢弃——读路径本就
  --     惰性兜底不出树，迁移一次清净）
  INSERT INTO node (id, production_id, kind, parent_id, sort_key, link_target_id, title, created_by, created_at)
  SELECT 'nd_' || substr(md5('alias:' || a.id), 1, 14), a.production_id, 'link',
         pn.id, a.sort_key, tn.id, a.display_title, a.created_by, a.created_at
  FROM wiki_alias a
  JOIN node tn ON tn.wiki_id IS NOT NULL AND tn.wiki_id::text = lower(a.target_id)
  LEFT JOIN node pn ON pn.wiki_id = a.parent_id
  WHERE a.target_type = 'wiki'
  ON CONFLICT DO NOTHING;

  -- 2.4 「资产」根（仅有资产的 production；无资产的等运行时 ensure 懒建）。
  --     锚点定式：无主（created_by NULL）、is_public=true 防漂根、listable=true。
  INSERT INTO node (id, production_id, kind, title, is_public, listable)
  SELECT 'nd_' || substr(md5('assets-root:' || p.id), 1, 14), p.id, 'folder', '资产', true, true
  FROM production p
  WHERE EXISTS (SELECT 1 FROM asset a WHERE a.production_id = p.id)
  ON CONFLICT DO NOTHING;
  INSERT INTO production_node_config (production_id)
  SELECT p.id FROM production p
  WHERE EXISTS (SELECT 1 FROM asset a WHERE a.production_id = p.id)
  ON CONFLICT DO NOTHING;
  UPDATE production_node_config c SET assets_root_node_id = n.id, updated_at = now()
  FROM node n
  WHERE n.id = 'nd_' || substr(md5('assets-root:' || c.production_id), 1, 14)
    AND c.assets_root_node_id IS NULL;

  -- 2.5 folder_path 展开为真实 folder 链（此后 folder_path 概念消亡）。
  --     规范化：按 '/' 切段、btrim、空段跳过；链上每级 id 由 (production, 规范化
  --     前缀路径) 确定——"设计/平面图" 与 "设计//平面图 " 收敛到同一链。
  FOR r IN
    SELECT DISTINCT m.production_id, m.folder_path
    FROM asset_mount m
    WHERE m.mount_type = 'production' AND m.folder_path IS NOT NULL AND btrim(m.folder_path) <> ''
    ORDER BY m.production_id, m.folder_path
  LOOP
    parent   := 'nd_' || substr(md5('assets-root:' || r.production_id), 1, 14);
    path_acc := '';
    FOREACH seg IN ARRAY string_to_array(r.folder_path, '/') LOOP
      seg := btrim(seg);
      CONTINUE WHEN seg = '';
      path_acc := path_acc || '/' || seg;
      fid := 'nd_' || substr(md5('folder:' || r.production_id || ':' || path_acc), 1, 14);
      INSERT INTO node (id, production_id, kind, parent_id, title, is_public, listable)
      VALUES (fid, r.production_id, 'folder', parent, seg, true, true)
      ON CONFLICT DO NOTHING;
      parent := fid;
    END LOOP;
  END LOOP;

  -- 2.6 asset → node。canonical 位置 = 最早的**带 folder_path** 的 production
  --     mount 之链叶（一个都没有 → 资产根）；listable = 是否存在 production
  --     mount（原「根共享区＝全员可见」由树可枚举性无缝接管，无 production
  --     mount 的保持不可枚举=今日隐私语义）；is_public 从 asset 拷贝。
  INSERT INTO node (id, production_id, kind, parent_id, is_public, listable, asset_id, created_by, created_at)
  SELECT 'nd_' || substr(md5('asset:' || a.id), 1, 14),
         a.production_id, 'asset',
         COALESCE(leaf.folder_node_id, 'nd_' || substr(md5('assets-root:' || a.production_id), 1, 14)),
         a.is_public,
         EXISTS (SELECT 1 FROM asset_mount pm
                 WHERE pm.asset_id = a.id AND pm.mount_type = 'production'),
         a.id, a.uploader_user_id, a.created_at
  FROM asset a
  LEFT JOIN LATERAL (
    SELECT 'nd_' || substr(md5('folder:' || a.production_id || ':' || '/' ||
             (SELECT string_agg(btrim(u.x), '/' ORDER BY u.ord)
              FROM unnest(string_to_array(pm.folder_path, '/')) WITH ORDINALITY AS u(x, ord)
              WHERE btrim(u.x) <> '')), 1, 14) AS folder_node_id
    FROM asset_mount pm
    WHERE pm.asset_id = a.id AND pm.mount_type = 'production'
      AND pm.folder_path IS NOT NULL AND btrim(replace(pm.folder_path, '/', '')) <> ''
    ORDER BY pm.created_at ASC
    LIMIT 1
  ) leaf ON true
  ON CONFLICT DO NOTHING;

  -- 2.7 同一 asset 其余不同 folder 的 production mount → link 节点（保多位置）。
  --     与 canonical 父同链的跳过；同容器同目标由 node_link_place_uidx 吞重。
  INSERT INTO node (id, production_id, kind, parent_id, link_target_id, created_by, created_at)
  SELECT 'nd_' || substr(md5('asset-link:' || pm.id), 1, 14),
         pm.production_id, 'link', lf.folder_node_id, an.id, pm.created_by, pm.created_at
  FROM asset_mount pm
  JOIN node an ON an.asset_id = pm.asset_id
  CROSS JOIN LATERAL (
    SELECT 'nd_' || substr(md5('folder:' || pm.production_id || ':' || '/' ||
             (SELECT string_agg(btrim(u.x), '/' ORDER BY u.ord)
              FROM unnest(string_to_array(pm.folder_path, '/')) WITH ORDINALITY AS u(x, ord)
              WHERE btrim(u.x) <> '')), 1, 14) AS folder_node_id
  ) lf
  WHERE pm.mount_type = 'production'
    AND pm.folder_path IS NOT NULL AND btrim(replace(pm.folder_path, '/', '')) <> ''
    AND lf.folder_node_id <> an.parent_id
  ON CONFLICT DO NOTHING;

  -- 2.8 锚点列翻译（wiki uuid → node id）
  UPDATE production_node_config c SET reports_root_node_id = n.id, updated_at = now()
  FROM node n WHERE n.wiki_id = c.reports_root_wiki_id AND c.reports_root_node_id IS NULL;
  UPDATE production_node_config c SET dramaturgy_root_node_id = n.id, updated_at = now()
  FROM node n WHERE n.wiki_id = c.dramaturgy_root_wiki_id AND c.dramaturgy_root_node_id IS NULL;
  UPDATE production_event e SET report_doc_node_id = n.id
  FROM node n WHERE n.wiki_id = e.report_doc_wiki_id AND e.report_doc_node_id IS NULL;
  UPDATE wiki_proposal wp SET parent_node_id = n.id
  FROM node n WHERE n.wiki_id = wp.parent_wiki_id AND wp.parent_node_id IS NULL;

  -- 2.9 report/note 边换键
  UPDATE event_report er SET node_id = n.id
  FROM node n WHERE n.wiki_id = er.wiki_id AND er.node_id IS NULL;
  UPDATE event_report_note rn SET node_id = n.id
  FROM node n WHERE n.wiki_id = rn.wiki_id AND rn.node_id IS NULL;

  -- 2.10 mount 值转译（在旧表原地做，改表前）
  -- block_snapshot → 稳定 block_id（同一 snapshot 在多个 version 行里 block_id
  -- 恒同，任取即可；映射不到的是孤儿快照化石，删）
  UPDATE asset_mount m SET mount_type = 'block', mount_id = sv.block_id
  FROM script_version sv
  WHERE m.mount_type = 'block_snapshot' AND sv.snapshot_id = m.mount_id;
  DELETE FROM asset_mount WHERE mount_type = 'block_snapshot';
  -- cue_revision → 稳定 cue.cue_id：mount_id 即 cue 修订行 id，直接取该行的
  -- 稳定身份列（#302 mention 体系同款锚定）。注意 cue_version.cue_id 存的是
  -- 行 id 不是稳定 id（VALUES ($1,$2,$1) 写入），不可经它映射。
  UPDATE asset_mount m SET mount_type = 'cue', mount_id = c.cue_id
  FROM cue c
  WHERE m.mount_type = 'cue_revision' AND c.id = m.mount_id;
  DELETE FROM asset_mount WHERE mount_type = 'cue_revision';
  -- 转译去重：多代快照的 CoW 复制边收敛到同一稳定 id 后撞车，保 created_at 最早
  DELETE FROM asset_mount m
  USING asset_mount m2
  WHERE m.mount_type IN ('block', 'cue')
    AND m2.mount_type = m.mount_type
    AND m2.asset_id = m.asset_id
    AND m2.mount_id = m.mount_id
    AND COALESCE(m2.mount_aux_id, '') = COALESCE(m.mount_aux_id, '')
    AND (m2.created_at < m.created_at OR (m2.created_at = m.created_at AND m2.id < m.id));
  -- 真化石（全仓零写入者；scene_snapshot 的 mount_id 语义两处代码互相矛盾，
  -- 无活数据可依）
  DELETE FROM asset_mount WHERE mount_type IN ('version', 'scene_snapshot');
  -- 嵌入边改名：宿主仍是 wiki uuid（嵌入属于正文，内容面寻址），可见性语义
  -- 「文档可见⇒图可见」一字不动，被退役的只是「wiki 作为组织归属」这个用途
  UPDATE asset_mount SET mount_type = 'embed' WHERE mount_type = 'wiki';
  -- production mount 退役（2.6 的 listable 已接管其「根共享区」语义）
  DELETE FROM asset_mount WHERE mount_type = 'production';

  -- 2.11 node_id 回填（每个 asset 必有 node——2.6 全量生成；FK CASCADE 保证
  --     mount 的 asset 都活着）
  UPDATE asset_mount m SET node_id = n.id
  FROM node n WHERE n.asset_id = m.asset_id AND m.node_id IS NULL;

  -- 2.12 部门分享面搬运
  INSERT INTO node_dept_share (node_id, dept_id, created_at)
  SELECT n.id, ws.dept_id, ws.created_at
  FROM wiki_dept_share ws JOIN node n ON n.wiki_id = ws.wiki_id
  ON CONFLICT DO NOTHING;

  -- 2.13 回滚依据：树列备份表 + alias 原表改名保留（落稳后单独 DROP）
  CREATE TABLE IF NOT EXISTS wiki_tree_backup_node_tree AS
  SELECT id AS wiki_id, parent_id, sort_key, is_public, listable FROM wiki;
  ALTER TABLE wiki_alias RENAME TO wiki_alias_backup_node_tree;
END $$;

-- ── §3 收尾结构 DDL（幂等；总闸跳过时这些多为 no-op）────────────────────────

-- report/note：NOT NULL + 新索引 + 删旧列（旧索引 event_report_wiki_idx 随列消亡）
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'event_report' AND column_name = 'wiki_id') THEN
    ALTER TABLE event_report      ALTER COLUMN node_id SET NOT NULL;
    ALTER TABLE event_report_note ALTER COLUMN node_id SET NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS event_report_node_idx      ON event_report (node_id);
CREATE INDEX IF NOT EXISTS event_report_note_node_idx ON event_report_note (node_id);
ALTER TABLE event_report      DROP COLUMN IF EXISTS wiki_id;
ALTER TABLE event_report_note DROP COLUMN IF EXISTS wiki_id;

-- asset_mount → node_mount 改造（改名/约束/索引对齐 schema.sql 新装库，
-- task-standalone 定式）
DO $$ BEGIN
  IF to_regclass('public.asset_mount') IS NOT NULL THEN
    ALTER TABLE asset_mount ALTER COLUMN node_id SET NOT NULL;
    ALTER TABLE asset_mount ADD CONSTRAINT node_mount_node_id_fkey
      FOREIGN KEY (node_id) REFERENCES node(id) ON DELETE CASCADE;
    ALTER TABLE asset_mount DROP COLUMN IF EXISTS asset_id;        -- asset_mount_asset_idx 随列消亡
    ALTER TABLE asset_mount DROP COLUMN IF EXISTS folder_path;
    ALTER TABLE asset_mount DROP COLUMN IF EXISTS mount_mode;
    ALTER TABLE asset_mount DROP COLUMN IF EXISTS version_resolved;
    -- 物理保险丝：退役词汇（production/wiki/version/*_snapshot/cue_revision）
    -- 的漏网写入者在此当场失败，而不是静默造出半迁移数据
    ALTER TABLE asset_mount ADD CONSTRAINT node_mount_type_check CHECK (mount_type IN
      ('scene', 'block', 'cue', 'comment', 'event', 'event_schedule', 'task', 'event_report', 'embed'));
    ALTER TABLE asset_mount RENAME TO node_mount;
    ALTER INDEX asset_mount_production_idx RENAME TO node_mount_production_idx;
    ALTER INDEX asset_mount_point_idx      RENAME TO node_mount_point_idx;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_mount_pkey') THEN
      ALTER TABLE node_mount RENAME CONSTRAINT asset_mount_pkey TO node_mount_pkey;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_mount_production_id_fkey') THEN
      ALTER TABLE node_mount RENAME CONSTRAINT asset_mount_production_id_fkey TO node_mount_production_id_fkey;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_mount_created_by_fkey') THEN
      ALTER TABLE node_mount RENAME CONSTRAINT asset_mount_created_by_fkey TO node_mount_created_by_fkey;
    END IF;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS node_mount_node_idx ON node_mount (node_id);

-- 锚点旧列删除（值已翻译进 *_node_id）
ALTER TABLE production_node_config DROP COLUMN IF EXISTS reports_root_wiki_id;
ALTER TABLE production_node_config DROP COLUMN IF EXISTS dramaturgy_root_wiki_id;
ALTER TABLE production_event       DROP COLUMN IF EXISTS report_doc_wiki_id;
ALTER TABLE wiki_proposal          DROP COLUMN IF EXISTS parent_wiki_id;

-- wiki 回归纯文档：四树列删除（wiki_parent_idx 随列消亡；备份表已建于 §2.13）
ALTER TABLE wiki DROP COLUMN IF EXISTS parent_id;
ALTER TABLE wiki DROP COLUMN IF EXISTS sort_key;
ALTER TABLE wiki DROP COLUMN IF EXISTS is_public;
ALTER TABLE wiki DROP COLUMN IF EXISTS listable;

-- asset.is_public 迁入 node 后删除（两个 public 位并存必漂移）
ALTER TABLE asset DROP COLUMN IF EXISTS is_public;

-- 退役表
DROP TABLE IF EXISTS wiki_dept_share;
DROP TABLE IF EXISTS asset_share_token;

COMMIT;
