-- ═══════════════════════════════════════════════════════════════════════════
-- node 树统一（epic #420 第一批）：node / node_dept_share 表
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 设计定谳见 docs/node-tree-design-2026-09-04.md 与 #420。一棵 node 树承载
-- **组织与权限**（wiki 文档 + asset 壳节点统一），异构业务边承载消费关系。
--
-- 本体论（2026-09-04 拍板）：
--   · 壳节点模型（飞书式）：树节点是壳（位置+权限），内容对象另存——wiki 表回归
--     纯文档、asset 表继续管文件与版本。
--   · 四种 kind：folder（纯文件夹）/ wiki / asset / link（软链接，接替 wiki_alias）。
--   · 一个 wiki/asset 只对应一个 node（partial unique 索引钉死）。
--   · 权限：枚举面沿祖先链求交（listable / dept_share / 内容域 meta@view 预取），
--     grant 行仍键在内容域（'wiki'/uuid、'asset'/id）**一行不迁**——`*@view` 的
--     sub 通配天然命中 meta 这条零迁移蕴含不能断（wiki-perm 教训）。
--   · 边不投枚举票：任何边种不得让节点在树里出现；内容面的挂载让渡=分享语义，
--     由各内容域判定函数自持（asset-perm 四通道）。
--
-- 列取舍：
--   · 目标指针用**三列专用真 FK**（wiki_id/asset_id/link_target_id），否决单列
--     TEXT 多态——wiki PK 是 UUID 而 asset/node 是 TEXT，单列丢类型丢 FK；真 FK
--     换来 asset 删 → node 级联 → node_mount 级联、node 删 → link 级联，
--     「悬空即删」多数路径物理化（读时 join 兜底仍保留，防御历史脏数据）。
--     代价：将来加第五种 kind 要 ALTER 加列改 CHECK——kind 增长极慢，接受。
--   · title：folder 的名字（必填）；link 的显示名覆盖（NULL=跟随目标实时标题，
--     沿 wiki_alias.display_title 定式，不存副本不分叉）；wiki/asset 恒 NULL
--     （标题在内容对象上）。
--   · kind='link' ⇒ listable=true ∧ is_public=false 由 CHECK 钉死：wiki_alias
--     「表上没有权限列」的物理保证（#358 洗白通道物理不存在）合表后换此形态。
--   · parent_id 的 ON DELETE SET NULL 只是绕过应用层时的兜底——删除路径由
--     deleteNode 在事务内做「子项上移一层」（同 deleteWiki #352 拍板）。
--
-- 自足守卫：幂等，可重复执行。migrate-node-tree.sql 镜像本文件全部 DDL。

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

  -- kind ↔ 目标/标题 组合钉死（恰一个目标列非空；folder 无目标有名字）
  CONSTRAINT node_kind_target_check CHECK (
       (kind = 'folder' AND wiki_id IS NULL     AND asset_id IS NULL     AND link_target_id IS NULL     AND title IS NOT NULL)
    OR (kind = 'wiki'   AND wiki_id IS NOT NULL AND asset_id IS NULL     AND link_target_id IS NULL     AND title IS NULL)
    OR (kind = 'asset'  AND wiki_id IS NULL     AND asset_id IS NOT NULL AND link_target_id IS NULL     AND title IS NULL)
    OR (kind = 'link'   AND wiki_id IS NULL     AND asset_id IS NULL     AND link_target_id IS NOT NULL)
  ),
  -- link 无权限语义（物理保证，见文件头）
  CONSTRAINT node_link_no_perm_check CHECK (
    kind <> 'link' OR (listable = true AND is_public = false)
  )
);

-- 一个 wiki/asset 只对应一个 node（本体规约）
CREATE UNIQUE INDEX IF NOT EXISTS node_wiki_uidx  ON node (wiki_id)  WHERE wiki_id  IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS node_asset_uidx ON node (asset_id) WHERE asset_id IS NOT NULL;
-- 同一容器下同一目标只一个软链接（沿 wiki_alias_place_target_uniq 语义；
-- 顶层 NULL parent 各算各的，维持现状，不引入 NULLS NOT DISTINCT）
CREATE UNIQUE INDEX IF NOT EXISTS node_link_place_uidx ON node (parent_id, link_target_id) WHERE kind = 'link';

CREATE INDEX IF NOT EXISTS node_production_idx  ON node (production_id);
CREATE INDEX IF NOT EXISTS node_parent_idx      ON node (parent_id);
CREATE INDEX IF NOT EXISTS node_link_target_idx ON node (link_target_id) WHERE link_target_id IS NOT NULL;

-- 部门分享面（接替 wiki_dept_share；树/分享面归 node 域）。
-- 结构面定式不变：判定时查部门成员，部门变动零 sweep，不物化 grant 行。
CREATE TABLE IF NOT EXISTS node_dept_share (
  node_id    TEXT        NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  dept_id    UUID        NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, dept_id)
);
