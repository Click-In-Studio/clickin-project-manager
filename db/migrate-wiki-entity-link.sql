-- wiki 双向链接泛化（wiki↔任意对象）：wiki_link → wiki_entity_link。
--
-- 旧 wiki_link 两列都是 UUID FK，只装得下 wiki→wiki 边。mention 体系
-- （lib/mention-types.ts）早已支持 scene/cue/asset/block 等 kind，wiki 正文里
-- 的跨对象引用一直存在，只是没有落边——对象侧因此看不到"被哪些 wiki 提过"。
--
-- 新表 wiki_entity_link：
--   · entity_type + entity_id 多态（scene/cue/task 等是 TEXT short id，wiki 是
--     UUID 存文本形式），无 DB 级 FK——存在性/归属校验在应用层（asset_mount 同款）。
--     悬空边容忍：反向查询只从活着的宿主页发起，幻影 entity 永远不被查到。
--   · production_id 反范式（从 wiki 抄）：反向查询的过滤锚，同时天然挡住
--     跨剧组 mention 的泄漏（边带来源剧组 id，目标剧组的页面查不到它）。
--   · origin：'wiki_body'=保存正文时解析派生（全删全插重建只清这种），
--     'manual'=显式建链（Phase 2 的 API 写入，重建不得触碰）。
--   · 边零权限语义：不进 canViewWiki / 任何可见性谓词。标题级列出、点击处
--     由目标页过门+申请（§4.1 名字不敏感、内容敏感）。report 边（event_report）
--     授可见是 report 自己的性质，与本表无关。
--
-- 数据搬迁：存量 wiki→wiki 边平移为 entity_type='wiki' 行（entity_id 转文本）。
-- 边表是正文的派生数据，下次保存会重建，但平移保证迁移瞬间 backlinks 不消失。

BEGIN;

CREATE TABLE IF NOT EXISTS wiki_entity_link (
  wiki_id       UUID        NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  entity_type   TEXT        NOT NULL,
  entity_id     TEXT        NOT NULL,
  origin        TEXT        NOT NULL DEFAULT 'wiki_body',
  created_by    UUID        NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wiki_id, entity_type, entity_id, origin)
);

CREATE INDEX IF NOT EXISTS wiki_entity_link_entity_idx
  ON wiki_entity_link (production_id, entity_type, entity_id);

INSERT INTO wiki_entity_link (wiki_id, production_id, entity_type, entity_id, origin)
SELECT l.source_wiki_id, w.production_id, 'wiki', l.target_wiki_id::text, 'wiki_body'
FROM wiki_link l
JOIN wiki w ON w.id = l.source_wiki_id
ON CONFLICT DO NOTHING;

DROP TABLE IF EXISTS wiki_link;

COMMIT;
