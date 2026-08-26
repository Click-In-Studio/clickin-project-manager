-- migrate-cue-mention-stable-id —— cue 引用换锚：行 id → 稳定 cue_id（#302）
--
-- 背景：mention 体系里 cue 是唯一锚**行 id**（cue.id）的 kind，scene/block 都锚
-- 稳定 id。cue 是修订表：改一次 cue 就 CoW 出新行 id，正文里的 `/__cm__/cue/<行id>`
-- 与 wiki_entity_link 中 entity_type='cue' 的边会一起变成 "#[已删除]" 幻影。
-- 全库方向已定（用户可见的引用一律锚稳定 id），本迁移把 cue 收进同一口径。
--
-- 与 migrate-wiki-dialect-v2 的分工：那条迁移改的是**方言文法**（规则复杂，
-- 改写逻辑在 TS 里唯一实现）；本条改的只是同一文法下的 **id 取值**，是一次字面
-- 替换，用 SQL 表达即可——不需要第二个改写脚本。
--
-- 四件事（同一事务）：
--   1. cue_id 回填 + 收 NOT NULL（存量若有 NULL，逻辑身份即它自己的行 id）
--   2. 正文四列里的 cue 引用平移到 cue_id（v2 与 v1 两种形态都收）
--   3. wiki_entity_link 的 cue 边平移到 cue_id（带去重——同一 wiki 引了同一逻辑
--      cue 的两条修订，平移后会撞主键）
--   4. 备份被改写的正文（回滚依据）
--
-- 幂等：跑第二遍时 remap 为空（cue_id <> id 的行都已改完），三步全是 no-op。
--
-- 执行：psql -f db/migrate-cue-mention-stable-id.sql
--       npx vitest run tests/cue-mention-stable-id.migration.test.ts
--
-- 回滚：UPDATE <表> SET <列> = b.body FROM cue_mention_text_backup b
--       WHERE b.table_name = '<表>' AND b.column_name = '<列>' AND <表>.id::text = b.row_id;
--       边表侧不可逆（去重丢掉的重复行无法还原）——但那些行本就是同一条边的
--       重复表达，还原它们没有意义。

BEGIN;

-- ── 0. 正文备份（回滚依据）───────────────────────────────────────────────────
-- 形状与 dialect_v2_text_backup 同款（通用四列），但独立成表：两次迁移的回滚
-- 依据不能互相覆盖。
CREATE TABLE IF NOT EXISTS cue_mention_text_backup (
  table_name  TEXT        NOT NULL,
  row_id      TEXT        NOT NULL,
  column_name TEXT        NOT NULL,
  body        TEXT        NOT NULL,
  taken_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, row_id, column_name)
);

-- ── 1. cue_id 回填 + NOT NULL ────────────────────────────────────────────────
-- createCue 一直是 VALUES ($1,$1,...)（cue_id = id），cowCue 一直是
-- COALESCE(cur.cue_id, cur.id)——所以 NULL 只可能来自 cue_id 列加上之前的存量行，
-- 它们的逻辑身份就是自己的行 id。
UPDATE cue SET cue_id = id WHERE cue_id IS NULL;

ALTER TABLE cue ALTER COLUMN cue_id SET NOT NULL;

-- ── 2. 正文平移 ──────────────────────────────────────────────────────────────
-- 只有被 CoW 过的 cue 需要平移（cue_id <> id）；cue_id = id 的行替换是恒等式。
-- 关键：remap 的**目标** id（cue_id）永远不会同时是某条 remap 的**键**——
-- cue_id 指向的就是初版行，而初版行的 cue_id = id 已被 WHERE 排除。所以逐条
-- 顺序替换不会发生二次改写，不需要考虑替换顺序。
--
-- 边界：id 是不透明 token，`cueXXX` 有可能是 `cueXXXY` 的前缀，裸 replace() 会
-- 咬断长 id。所以按尾随分隔符锚定并回填捕获组——分隔符集合取自 lib/wiki-db.ts
-- 的 CM_HREF_RE / CM_HREF_LEGACY_RE，两条正则认到哪，这里就替到哪。
-- （id 由 newCueId / shortId 生成，全是 [0-9a-z] 字面量，不含正则元字符。）
--
-- 刻意不做代码围栏保护（extractMentionEdges 会剥 ``` 与行内码再提边，本迁移不剥）：
-- 围栏里的 `/__cm__/cue/<id>` 是"关于语法的文档"，不是引用，不落边；把里面的 id
-- 一并平移不会改变它作为示例的正确性，反而让文档示例继续指向活着的 cue。为此把
-- 围栏解析在 SQL 里再实现一遍，不划算。
DO $$
DECLARE
  r            RECORD;
  target       RECORD;
  v2_pattern   TEXT;
  v1_pattern   TEXT;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('wiki',               'id', 'body'),
      ('comment',            'id', 'body'),
      ('user_notification',  'id', 'body'),
      ('agent_memory_chunk', 'id', 'text')
    ) AS t(table_name, id_col, col)
  LOOP
    -- 列不存在就跳过（与 scripts/migrate-wiki-dialect.ts 同款容错）
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = target.table_name AND column_name = target.col
    );

    FOR r IN SELECT id AS old_id, cue_id AS new_id FROM cue WHERE cue_id <> id
    LOOP
      v2_pattern := '/__cm__/cue/' || r.old_id || '([)?#&])';
      v1_pattern := '/__cm__cue:'  || r.old_id || '([):?&])';

      -- 备份：只备份**将被本次改写命中**的行，且 DO NOTHING 保证重跑不会用
      -- 已改写的正文覆盖掉原始备份（dialect v2 同款教训）。
      EXECUTE format(
        'INSERT INTO cue_mention_text_backup (table_name, row_id, column_name, body)
         SELECT %L, %I::text, %L, %I FROM %I
         WHERE %I ~ %L OR %I ~ %L
         ON CONFLICT (table_name, row_id, column_name) DO NOTHING',
        target.table_name, target.id_col, target.col, target.col, target.table_name,
        target.col, v2_pattern, target.col, v1_pattern
      );

      EXECUTE format(
        'UPDATE %I SET %I = regexp_replace(
           regexp_replace(%I, %L, %L, ''g''), %L, %L, ''g'')
         WHERE %I ~ %L OR %I ~ %L',
        target.table_name, target.col, target.col,
        v2_pattern, '/__cm__/cue/' || r.new_id || '\1',
        v1_pattern, '/__cm__cue:'  || r.new_id || '\1',
        target.col, v2_pattern, target.col, v1_pattern
      );
    END LOOP;
  END LOOP;
END $$;

-- ── 3. wiki_entity_link 的 cue 边平移 ────────────────────────────────────────
-- 直接 UPDATE 会撞主键 (wiki_id, entity_type, entity_id, origin)：同一篇 wiki
-- 引了同一逻辑 cue 的两条修订，平移后两行变成同一行。所以重建而非改写——
-- DISTINCT ON 收敛到一条，保留最早的 created_at/created_by（边的"何时建立"
-- 应当是首次建立，不是重复表达里的最后一条）。
--
-- COALESCE：查不到 c.id 的边是悬空边（宿主行已删）——按设计容忍（lib/wiki-db.ts
-- syncWikiLinks 的注释），无从反查其 cue_id，原样保留。它们在换锚前后同样解析为
-- "#[已删除]"，不因本迁移变坏。
CREATE TEMP TABLE cue_edge_remap ON COMMIT DROP AS
SELECT DISTINCT ON (l.wiki_id, l.origin, COALESCE(c.cue_id, l.entity_id))
       l.wiki_id,
       l.production_id,
       COALESCE(c.cue_id, l.entity_id) AS entity_id,
       l.origin,
       l.created_by,
       l.created_at
FROM wiki_entity_link l
LEFT JOIN cue c ON c.id = l.entity_id
WHERE l.entity_type = 'cue'
ORDER BY l.wiki_id, l.origin, COALESCE(c.cue_id, l.entity_id), l.created_at;

DELETE FROM wiki_entity_link WHERE entity_type = 'cue';

INSERT INTO wiki_entity_link
  (wiki_id, production_id, entity_type, entity_id, origin, created_by, created_at)
SELECT wiki_id, production_id, 'cue', entity_id, origin, created_by, created_at
FROM cue_edge_remap;

COMMIT;

-- 迁移后自检（应当四条都返回 0 行）。
--
--   -- a) 正文里不再有指向行 id 的 cue 引用
--   WITH bad AS (SELECT id, cue_id FROM cue WHERE cue_id <> id)
--   SELECT 'wiki' AS t, w.id::text FROM wiki w, bad
--     WHERE w.body ~ ('/__cm__/cue/' || bad.id || '[)?#&]')
--        OR w.body ~ ('/__cm__cue:'  || bad.id || '[):?&]')
--   UNION ALL
--   SELECT 'comment', c.id::text FROM comment c, bad
--     WHERE c.body ~ ('/__cm__/cue/' || bad.id || '[)?#&]')
--        OR c.body ~ ('/__cm__cue:'  || bad.id || '[):?&]')
--   UNION ALL
--   SELECT 'user_notification', n.id::text FROM user_notification n, bad
--     WHERE n.body ~ ('/__cm__/cue/' || bad.id || '[)?#&]')
--        OR n.body ~ ('/__cm__cue:'  || bad.id || '[):?&]')
--   UNION ALL
--   SELECT 'agent_memory_chunk', m.id::text FROM agent_memory_chunk m, bad
--     WHERE m.text ~ ('/__cm__/cue/' || bad.id || '[)?#&]')
--        OR m.text ~ ('/__cm__cue:'  || bad.id || '[):?&]');
--
--   -- b) 边表里不再有指向行 id 的 cue 边
--   SELECT l.* FROM wiki_entity_link l JOIN cue c ON c.id = l.entity_id
--   WHERE l.entity_type = 'cue' AND c.cue_id <> c.id;
