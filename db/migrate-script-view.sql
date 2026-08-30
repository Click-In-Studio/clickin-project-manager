-- script_view 实体（#336 阶段 B2，engrave epic #337）：版式从 production.script_config
-- 的两个 JSONB 键搬进独立的表，DB 层从此按「一个演出 N 个本子 + 一个主本」建模。
--
-- 为什么现在建、而且一步到位按多视图建：epic 里 D 阶段（#339）要做导演本 / 舞监本 /
-- 演员分册各自一套版式与内容过滤。若此时只把版式留在 JSONB 里，D 要迁移全部存量；
-- 而 page_map 若继续按版式串键，多本上线后存量页码就不知道说的是哪个本子的第 47 页。
--
-- 做的事：
--   1. 建 script_view：TEXT PK + short id（仓库 id 规约），page_layout / text_layout_mode
--      是今天的全部版式；page_sequence / template_overrides 两列只是**位置预留**
--      （F 阶段的杂页 / 首页序列、C 阶段的模版分层继承），缺省值等价于「只有内容流、
--      不覆盖任何模版」，本阶段无读者。
--   2. production.master_view_id：主本。页码与分页引擎的输入来源（epic 决策 1 给 #349
--      留的位置：若最终需要「标准本」，必然是某个 layout 承担）。FK 不带 ON DELETE，
--      主本因此在库层不可删。
--   3. 回填：每个演出一条主本，版式取自 script_config，非法值落回缺省。
--   4. 剥掉 production / version script_config 里的 pageLayout / textLayoutMode 键——
--      从此只有 script_view 一处真相，ScriptConfig 类型不变、由 loadProduction 从主本装配。
--   5. page_map 改按 view id 键：{ "<layout>": {...} } → { "<master_view_id>": {...} }，
--      只保留主本当前版式那份（其余三份是「万一改版式」的预算，现在改版式会全量重算）。
--
-- 幂等：可重复执行。建表 / 加列 IF NOT EXISTS；回填只补 master_view_id IS NULL 的演出；
-- page_map 改键只动仍按版式串键的行。

BEGIN;

CREATE TABLE IF NOT EXISTS script_view (
  id                 TEXT PRIMARY KEY,
  production_id      TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name               TEXT NOT NULL DEFAULT '',
  page_layout        TEXT NOT NULL DEFAULT 'a4'
                     CHECK (page_layout IN ('a4', 'letter', 'a3-2col', 'tablet-2col')),
  text_layout_mode   TEXT NOT NULL DEFAULT 'center'
                     CHECK (text_layout_mode IN ('center', 'compact')),
  -- 页序列位置预留（F 阶段）：[首页, 目录页, 《内容流》, 杂页, …]。缺省只有内容流。
  page_sequence      JSONB NOT NULL DEFAULT '[{"kind":"content"}]',
  -- 模版分层继承位置预留（C 阶段）：演出级默认模版集 → 本视图只覆盖需要不同的项。
  template_overrides JSONB NOT NULL DEFAULT '{}',
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS script_view_production_idx ON script_view(production_id, sort_order);

ALTER TABLE production ADD COLUMN IF NOT EXISTS master_view_id TEXT;

-- 循环 FK（production → script_view → production），与 active_version_id 同一处理。
-- 无 ON DELETE 子句 = NO ACTION：主本行不可被单独删除；删演出时级联删 script_view，
-- 引用它的 production 行在同一语句里已消失，语句末校验通过。
DO $$ BEGIN
  ALTER TABLE production ADD CONSTRAINT production_master_view_id_fkey
    FOREIGN KEY (master_view_id) REFERENCES script_view(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. 回填主本。id 按仓库 short id 规约：前缀 + 时间 + 随机尾（会出现在 URL 里，不用 UUID）。
WITH created AS (
  INSERT INTO script_view (id, production_id, name, page_layout, text_layout_mode)
  SELECT
    'sv_' || to_hex((extract(epoch FROM clock_timestamp()) * 1000)::bigint)
          || substr(md5(random()::text || p.id), 1, 8),
    p.id,
    '标准本',
    CASE WHEN p.script_config->>'pageLayout' IN ('a4', 'letter', 'a3-2col', 'tablet-2col')
         THEN p.script_config->>'pageLayout' ELSE 'a4' END,
    CASE WHEN p.script_config->>'textLayoutMode' IN ('center', 'compact')
         THEN p.script_config->>'textLayoutMode' ELSE 'center' END
  FROM production p
  WHERE p.master_view_id IS NULL
  RETURNING id, production_id
)
UPDATE production p
   SET master_view_id = c.id
  FROM created c
 WHERE c.production_id = p.id;

-- 5. page_map 改按主本 id 键（要在剥键之前做——剥了就不知道原来是哪个版式了；
--    但主本已在上一步按同一规则建好，直接读主本的版式即可，与 script_config 是否已剥无关）。
UPDATE production p
   SET page_map = CASE WHEN p.page_map ? sv.page_layout
                       THEN jsonb_build_object(sv.id, p.page_map -> sv.page_layout)
                       ELSE '{}'::jsonb END
  FROM script_view sv
 WHERE sv.id = p.master_view_id
   AND NOT (p.page_map ? sv.id)
   AND (p.page_map ?| ARRAY['a4', 'letter', 'a3-2col', 'tablet-2col']);

-- 4. 剥旧键：script_view 成为版式唯一真相。
UPDATE production
   SET script_config = script_config - 'pageLayout' - 'textLayoutMode'
 WHERE script_config ?| ARRAY['pageLayout', 'textLayoutMode'];

UPDATE version
   SET script_config = script_config - 'pageLayout' - 'textLayoutMode'
 WHERE script_config ?| ARRAY['pageLayout', 'textLayoutMode'];

COMMIT;
