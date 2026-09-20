-- #357 wiki 可枚举性：枚举面（目录树）与内容面（能否读）分家。
--
-- listable = 「对能枚举我父节点的人，我出现在目录里」。判定沿祖先链求交，永不物化：
--   可枚举(u, X) ⟺ 可枚举(u, parent(X)) ∧ (X.listable ∨ u 持 wiki/X meta@view 行)
--   可枚举(u, 顶层节点) ⟺ X.listable ∨ u 持 meta@view 行
-- 前置合取项保证不变量 E(子) ⊆ E(父) 结构成立——任何人看到的都是含根的连通子树，
-- 树上不可能出现断链；隐一个节点即隐整棵子树，零级联写、不可能漂移（§0.9 姿态）。
--
-- 存量回填 true：此前枚举面与内容面共用一个门（*@view），可枚举性是残疾的。
-- 新默认＝名字随位置、内容随属性，两个默认正交（#357 症状⑥）。
ALTER TABLE wiki ADD COLUMN IF NOT EXISTS listable BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN wiki.listable IS
  '可枚举性（#357）：true=对能枚举父节点者出现在目录树；false=仅显式 meta@view 持有者可枚举，他人只能经 wikilink 到达且看不到其子文档。内容可读性由 is_public/grant 独立决定。';
