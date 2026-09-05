-- 实体目录指针（#420 缺省落点第二弹，2026-09-05 拍板）：
-- 「业务实体的缺省目录」惰性 get-or-create 的指针表。名字不存真相——folder 节点
-- 的 title 是实体名的副本，解析时惰性跟随（lib/node/landing.ts）。
-- 当前使用者：script '*'（「剧本」域目录）、cue_root '*'（「Cue」域目录）、
-- cue_list <id>（每 cue 表一个子目录）。event 系不在此表（production_event.
-- report_doc_node_id 先例列继续用）。
CREATE TABLE IF NOT EXISTS node_entity_dir (
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  node_id       TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (production_id, entity_type, entity_id)
);
