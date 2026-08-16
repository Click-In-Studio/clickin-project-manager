-- wiki_proposal 从只隐式支持 create 扩展到 create/update/delete/move 四种动作。
--
-- action 标定这行到底是哪种提议；target_wiki_id 是被操作的既有文档
-- （create 没有，其余三种都要——不能复用 parent_wiki_id，move 动作两个
-- 字段都要用：target_wiki_id=被移动的文档、parent_wiki_id=移动到的新父）。
-- title/body 从 create 专属的必填字段松绑成可选——update 可能只改标题不改
-- 正文，delete/move 两个字段都用不上。
--
-- 幂等，可重复执行。存量行（清一色是旧版 create）用 DEFAULT 'create' 回填，
-- 不触及既有语义，也不需要额外的数据迁移步骤。

BEGIN;

ALTER TABLE wiki_proposal ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT 'create';
ALTER TABLE wiki_proposal ADD COLUMN IF NOT EXISTS target_wiki_id UUID NULL REFERENCES wiki(id) ON DELETE SET NULL;

ALTER TABLE wiki_proposal DROP CONSTRAINT IF EXISTS wiki_proposal_action_check;
ALTER TABLE wiki_proposal ADD CONSTRAINT wiki_proposal_action_check
  CHECK (action IN ('create', 'update', 'delete', 'move'));

ALTER TABLE wiki_proposal ALTER COLUMN title DROP NOT NULL;

-- delete 动作可能因业务规则（被挂载/系统锚点）拦下，不是权限问题——
-- 复用 blocked_no_permission 会误导前端"去申请权限"，加一个专门的状态。
ALTER TABLE wiki_proposal DROP CONSTRAINT IF EXISTS wiki_proposal_status_check;
ALTER TABLE wiki_proposal ADD CONSTRAINT wiki_proposal_status_check
  CHECK (status IN ('pending', 'applied', 'blocked_no_permission', 'blocked_business_rule', 'rejected'));

COMMIT;
