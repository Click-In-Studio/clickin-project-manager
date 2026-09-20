-- wiki_proposal 加第五种动作 tag：整体替换一篇既有文档的标签列表
-- （对应 updateWiki 的 patch.tags 语义——全量替换，不是增量追加）。
--
-- 幂等，可重复执行。存量行不受影响（action 列已有默认值机制，这里只是
-- 放宽 CHECK 允许的取值集合）。

BEGIN;

ALTER TABLE wiki_proposal ADD COLUMN IF NOT EXISTS tags TEXT[] NULL;

ALTER TABLE wiki_proposal DROP CONSTRAINT IF EXISTS wiki_proposal_action_check;
ALTER TABLE wiki_proposal ADD CONSTRAINT wiki_proposal_action_check
  CHECK (action IN ('create', 'update', 'delete', 'move', 'tag'));

COMMIT;
