-- migrate-wiki-dialect-v2 —— wiki 正文方言 v1 → v2 统一
--
-- 背景：wiki.body 的私有方言积到 7 类活跃形态 + 7 种存量/废弃形态，其中
-- contentMention 一个语义分裂成「DB token / href 链接」两种正史形态外加两种
-- 转义损坏形态。本迁移把 **markdown 上下文**（wiki.body）的引用/嵌入/布局三类
-- 统一到 v2 文法，并清掉全部废弃形态。
--
--   引用  [#label](/__cm__<kind>:<id>[?v=][:aux])  →  [#](/__cm__/<type>/<id>[?as=&v=&aux=])
--   @提及 [@名](uid:<userId>)                      →  [@名](/__cm__/user/<userId>)
--   嵌入  ![alt](/__cm__asset:<id>)                →  ![alt](/__cm__/asset/<id>)
--   废弃  [#wiki:<uuid>] 裸 token                  →  [#](/__cm__/wiki/<uuid>)
--   布局  > [!💡|#fff5eb]                          →  > [!💡 bg=#fff5eb]
--
-- ⚠️ 本迁移**没有 DDL**（不改列、不改类型），schema.sql / seed-schema.json 无需
--    更新——正文改写是 DML，而且改写规则复杂（参数重排、转义修复、代码块保护），
--    用 regexp_replace 在 SQL 里重写一遍等于把同一套规则实现两次，正是本次要
--    清理的「一个语义多种实现」。所以：
--
--      正文改写由 scripts/migrate-wiki-dialect.ts 执行，
--      规则唯一实现在 lib/wiki-dialect-migrate.ts（有 21 项单测护栏）。
--
--    本文件负责迁移的**不可回滚性兜底**与**迁移标记**：备份表既是回滚依据，
--    也是「是否已迁移」的判据（tests/wiki-dialect-v2-snapshot.ts 的 PRE 判据）。
--
-- 执行顺序：
--   1) psql -f db/migrate-wiki-dialect-v2.sql   （建备份表 + 全量快照）
--   2) npx tsx scripts/migrate-wiki-dialect.ts  （改写 wiki.body）
--   3) npx vitest run tests/wiki-dialect-v2.migration.test.ts
--
-- 回滚：UPDATE wiki w SET body = b.body FROM wiki_body_backup_dialect_v2 b
--       WHERE b.wiki_id = w.id;
--       解析侧对 v1 形态保留只读兼容，回滚后渲染/编辑/边提取均正常。

BEGIN;

CREATE TABLE IF NOT EXISTS wiki_body_backup_dialect_v2 (
  wiki_id    UUID        PRIMARY KEY REFERENCES wiki(id) ON DELETE CASCADE,
  body       TEXT        NOT NULL,
  taken_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 全量快照。ON CONFLICT DO NOTHING 保证可重跑：第二次执行不会用「已迁移的
-- 正文」覆盖掉原始备份（那会让回滚依据变成迁移后的内容，等于没有备份）。
INSERT INTO wiki_body_backup_dialect_v2 (wiki_id, body)
SELECT id, body FROM wiki
ON CONFLICT (wiki_id) DO NOTHING;

COMMIT;

-- 迁移后自检（脚本跑完再执行，应当返回 0 行）：
--   SELECT id, title FROM wiki
--   WHERE body ~ '\(/__cm__[a-z_.]+:'      -- 旧引用 href
--      OR body ~ '\(uid:'                   -- 旧 @提及 scheme
--      OR body ~ '\[#wiki:'                 -- 废弃裸 token
--      OR body ~ '^\s*>+\s*\[![^]]*\|#'     -- callout 管道参数
--   ;
