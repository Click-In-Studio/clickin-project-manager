-- #358 wiki 软链接：伪节点指向目标，让一篇文档出现在多个层级。
--
-- 本文件**推翻** W1 那句「文档树=内禀 parent_id（标准树非图）」——树本身仍是树
-- （每个 wiki 行仍只有一个 parent_id），但目录树的节点集从此是
-- 「wiki 行 ∪ wiki_alias 行」。db/schema.sql W1 段注释已同批改写，两处记录不得分叉。
--
-- 形态取「独立表」而非「wiki 加 target 列」（#358 方案 B）：
--   加列的代价是每一个 wiki 消费方（body / mentions / revision / grant 行 / 全文
--   检索 / wiki_entity_link）都要学会「这行是别名」，漏一处不报错、只给出看起来
--   正常的错结果；独立表的代价是树的组装要认两种节点——集中、可枚举、编译期可见。
--
-- 【不可让步的不变量】别名不得成为独立的授权面。
--   本表**没有** listable / is_public 列，也不接受任何 grant 行、部门分享行——
--   结构上就没有地方能持有授权，「建别名指向私密文档 → 把别名设为公开」这条权限
--   洗白通道物理不存在。判定式：
--     可枚举(u, 别名) ⟺ 可枚举(u, 别名的父) ∧ 本地可枚举(u, 目标)
--     读正文        ⟺ 目标自己的 canViewWiki(u, 目标)   ← 永远重判目标，不看别名
--   第二合取项刻意取**本地**可枚举（目标自己的 listable / meta@view 行 / 部门分享），
--   不含目标自己那条祖先链：别名给了目标第二个**位置**，位置这一维由别名的父链承担，
--   节点自身属性一分不放。取「全可枚举(目标)」则别名对「把埋在私密子树里的一篇提到
--   灵感库」这个主用途永远不可见，功能当场失效（#358 拍板）。
--
-- 目标多态（target_type/target_id，照 wiki_entity_link 定式：多态无 FK，存在性
-- 校验在应用层）：本批只实现 'wiki'，'asset' 等留待接入——每种目标只需实现
-- 「存在?/标题/本地可枚举/内容门/href」五件事（lib/wiki-alias-db.ts 解析器接口）。
-- 无 FK ⇒ 目标删除不级联：wiki 目标由 deleteWiki 在同一事务内主动清（连同「子文档
-- 上移一层」），读路径一律 join 目标、解析不到的别名不出现在树里（惰性兜底）。
--
-- 幂等，可重复执行。

BEGIN;

CREATE TABLE IF NOT EXISTS wiki_alias (
  id            TEXT        PRIMARY KEY,
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  -- 位置：与真实子项同一个父空间、同一把排序尺（lib/lex-order.ts）。
  -- NULL=顶层。父被删时应用层把别名与真实子文档一同上移一层（deleteWiki），
  -- SET NULL 只是绕过应用层时的兜底——同 wiki.parent_id 的姿态。
  parent_id     UUID        NULL REFERENCES wiki(id) ON DELETE SET NULL,
  sort_key      TEXT        NULL,
  target_type   TEXT        NOT NULL DEFAULT 'wiki',
  target_id     TEXT        NOT NULL,
  -- 显示名：NULL＝跟随目标的实时标题（缺省，不会分叉）。给值＝这个位置上叫别的名字
  -- （「同一篇文档在不同语境下叫不同名字」）。纯标签，**不参与任何判定**——别名可不
  -- 可枚举仍只看「父可枚举 ∧ 本地可枚举(目标)」，改显示名不披露目标的任何东西。
  display_title TEXT        NULL,
  created_by    UUID        NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 同一容器下同一目标只允许一个别名（重复别名没有语义，只会让树里出现两行同名）
  CONSTRAINT wiki_alias_place_target_uniq UNIQUE (parent_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS wiki_alias_production_idx ON wiki_alias (production_id);
CREATE INDEX IF NOT EXISTS wiki_alias_parent_idx     ON wiki_alias (parent_id);
-- 目标侧反查（deleteWiki 清理、「本篇被软链接到哪些位置」面板）
CREATE INDEX IF NOT EXISTS wiki_alias_target_idx     ON wiki_alias (target_type, target_id);

COMMENT ON COLUMN wiki_alias.display_title IS
  '别名在这个位置上的显示名；NULL＝跟随目标实时标题。纯标签，不参与可枚举性/内容门判定。';

COMMENT ON TABLE wiki_alias IS
  '#358 wiki 软链接：目录树里指向目标的伪节点。别名是叶子（不可有子项，链式别名结构上不可表达）。无 listable/is_public/grant 行——别名不得成为独立授权面：可枚举(别名)=可枚举(父) ∧ 本地可枚举(目标)，读正文永远重判目标。';

COMMIT;
