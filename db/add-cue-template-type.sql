-- #227 项目自定义 Cue 表模版：类型注册表从代码常量（CUE_LIST_TEMPLATES）迁为
-- production 级数据。声明行机制（dept_cue_list_template）对任意类型零代码。
-- 展示层配置（abbr 提示）随类型走；creator_roles 仅信息展示（建表资格走声明表）。

CREATE TABLE IF NOT EXISTS production_cue_template_type (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  key           TEXT        NOT NULL,
  abbr_hint     TEXT,
  creator_roles TEXT[]      NOT NULL DEFAULT '{}',
  display_order INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (production_id, key)
);

CREATE INDEX IF NOT EXISTS production_cue_template_type_prod_idx
  ON production_cue_template_type (production_id, display_order);

-- 存量项目 seed 内置八类型（与原 CUE_LIST_TEMPLATES / TEMPLATE_ABBR_HINTS 一致）
INSERT INTO production_cue_template_type (production_id, key, abbr_hint, creator_roles, display_order)
SELECT p.id, t.key, t.abbr, t.roles, t.ord
FROM production p
CROSS JOIN (VALUES
  ('灯光',     'LQ', ARRAY['灯光设计'],                     1),
  ('追光',     'FQ', ARRAY['灯光设计'],                     2),
  ('音效',     'SQ', ARRAY['音响设计'],                     3),
  ('音乐',     'MQ', ARRAY['音响设计','作曲','编曲'],       4),
  ('多媒体',   'VQ', ARRAY['多媒体设计'],                   5),
  ('舞台机械', 'AQ', ARRAY['舞美设计','舞台监督'],          6),
  ('催场',     'CQ', ARRAY['舞台监督'],                     7),
  ('预设',     'PQ', ARRAY['舞台监督'],                     8)
) AS t(key, abbr, roles, ord)
ON CONFLICT (production_id, key) DO NOTHING;
