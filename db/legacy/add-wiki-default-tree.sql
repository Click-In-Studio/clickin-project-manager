-- wiki 文档库：默认文档树（2026-08-16 用户拍板，路线笔记 §4 第 9 项）。
--
-- 创建报告 → 默认挂「报告」根目录文档 →「<event 标题>」事件目录文档之下；
-- 创建 note → 自动挂其报告文档之下。自定义挂载除外；存量不迁移。
-- 锚点是普通 wiki（可改名/移动，锚认 id 不认位置）；目录文档完全公开
-- （is_public=true——否则成员看得见报告看不见祖先，树渲染漂根）。
--
-- production_wiki_config = production 级可配置表（未来扩展：改配置=改根目录名、
-- 开关默认目录等）；event 锚点随 event 行走（production_event 列）。
--
-- 幂等，可重复执行。纯新增，无存量数据语义。

BEGIN;

CREATE TABLE IF NOT EXISTS production_wiki_config (
  production_id        TEXT    PRIMARY KEY REFERENCES production(id) ON DELETE CASCADE,
  reports_tree_enabled BOOLEAN NOT NULL DEFAULT true,
  reports_root_title   TEXT    NOT NULL DEFAULT '报告',
  reports_root_wiki_id UUID    NULL REFERENCES wiki(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE production_event
  ADD COLUMN IF NOT EXISTS report_doc_wiki_id UUID NULL REFERENCES wiki(id) ON DELETE SET NULL;

COMMIT;
