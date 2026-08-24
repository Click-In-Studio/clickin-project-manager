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
-- ⚠️ 本迁移**不改动任何既有表**（不加列、不删列、不改类型）——只新建两张备份表，
--    正文改写全是 DML。（措辞更正：新建表本身当然是 DDL，schema.sql 与
--    seed-schema.json 已同步收录这两张表；这里要说的是"不动存量结构"。）
--    改写规则复杂（参数重排、转义修复、代码块保护），
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

-- 扫描生产库发现方言不止活在 wiki.body：AI 记忆与两条通知/评论也带 v1 形态。
-- 记忆里的旧语法尤其要清——它会随记忆注入模型上下文，比 AI 说明书更有说服力，
-- 等于持续教模型写已退役的语法。
-- 这些列没有各自的备份表，统一记进一张通用备份表（同样是回滚依据）。
CREATE TABLE IF NOT EXISTS dialect_v2_text_backup (
  table_name  TEXT        NOT NULL,
  row_id      TEXT        NOT NULL,
  column_name TEXT        NOT NULL,
  body        TEXT        NOT NULL,
  taken_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, row_id, column_name)
);

COMMIT;

-- 迁移后自检（脚本跑完再执行，四条都应当返回 0 行）。
-- 覆盖脚本改写的**全部**列，不只是 wiki.body——漏检等于没检。
--
--   WITH v1 AS (SELECT $$(\(/__cm__[a-z_.]+:)|(\(uid:)|(\[#wiki:)$$ AS re)
--   SELECT 'wiki' AS t, id::text FROM wiki, v1
--     WHERE body ~ v1.re OR body ~ '^\s*>+\s*\[![^]]*\|#'
--   UNION ALL
--   SELECT 'agent_memory_chunk', id::text FROM agent_memory_chunk, v1 WHERE text ~ v1.re
--   UNION ALL
--   SELECT 'comment', id::text FROM comment, v1 WHERE body ~ v1.re
--   UNION ALL
--   SELECT 'user_notification', id::text FROM user_notification, v1 WHERE body ~ v1.re
--   ;
--
-- 注：wiki_revision / wiki_proposal 是历史台账，**按设计不迁移**，不要纳入自检。
