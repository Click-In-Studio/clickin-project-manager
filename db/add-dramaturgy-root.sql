-- 「戏剧构作」系统根目录（wiki 双向链接 Phase 2）：从 dramaturgy 场景侧新建的
-- 文档默认落位处。与 reports 三列同构（懒建、锚认 id、可改名可移动、删除保护）。
--
-- 刻意只做单层根、不做 per-scene 子目录：scene 是结构性易变实体（拆/并/删/重排），
-- 且 wiki↔scene 是 m:n 引用（一份大纲覆盖多场）——"属于哪个场"由 wiki_entity_link
-- 的 manual 边表达，树只管收纳，一个真相源。event 报告树的 per-event 层成立的
-- 前提（report 1:n 独占从属、event 稳定追加）在 scene 上都不成立。

ALTER TABLE production_wiki_config
  ADD COLUMN IF NOT EXISTS dramaturgy_tree_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS dramaturgy_root_title   TEXT    NOT NULL DEFAULT '戏剧构作',
  ADD COLUMN IF NOT EXISTS dramaturgy_root_wiki_id UUID    NULL REFERENCES wiki(id) ON DELETE SET NULL;
