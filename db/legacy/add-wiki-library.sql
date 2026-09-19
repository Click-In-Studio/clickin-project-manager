-- wiki 文档库 W1+W2（report 独立化批次一）：文档树/分享面/链接/tag/线性历史 + wiki 权限词汇。
--
-- 设计账本：MindWeave《wiki文档库-现状调研与实施路线》§4 八项拍板 + 总表 §0.10 本体论。
-- 模型要点：
--   · 文档树 = 内禀 parent_id（标准树非图，不用挂载边）+ fractional sort_key（lib/lex-order.ts）；
--     树层级不进权限路径（三层树硬约束），权限仍 wiki/<id>/<sub> 平铺
--   · 可见性推导（asset 隐私模型同构）：个人 grant 行 ∨ is_public ∨ dept 分享面
--     ∨ ∃挂载边:宿主可见。挂载/分享面永不物化 grant 行（§0.9 负面清单），新建默认隐私
--   · wiki_link 只存 id→id 结构事实；标题=目录级信息（沿引用边可见），内容过权限门（§4.1）
--   · wiki_revision 先建表后补 UI；origin 列为 AI 化 provenance 预留（'user' | agent 归因）
--
-- 幂等，可重复执行。CREATE EXTENSION pg_trgm 需 postgres 用户执行（列入部署清单）。

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 树 + 结构可见性列 ─────────────────────────────────────────────────────────
-- parent_id ON DELETE SET NULL：删除父文档时子文档提升为根，不级联删内容
ALTER TABLE wiki ADD COLUMN IF NOT EXISTS parent_id UUID NULL REFERENCES wiki(id) ON DELETE SET NULL;
ALTER TABLE wiki ADD COLUMN IF NOT EXISTS sort_key  TEXT NULL;
ALTER TABLE wiki ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS wiki_parent_idx ON wiki (parent_id);

-- ── 交叉引用边（保存时服务端解析正文提取；backlinks/unlinked references 数据基础）──
CREATE TABLE IF NOT EXISTS wiki_link (
  source_wiki_id UUID NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  target_wiki_id UUID NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  PRIMARY KEY (source_wiki_id, target_wiki_id)
);

CREATE INDEX IF NOT EXISTS wiki_link_target_idx ON wiki_link (target_wiki_id);

-- ── 自由 tag（必可手写，非受控词表；production 归属经 wiki join）──────────────
CREATE TABLE IF NOT EXISTS wiki_tag (
  wiki_id UUID NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (wiki_id, tag)
);

CREATE INDEX IF NOT EXISTS wiki_tag_tag_idx ON wiki_tag (tag);

-- ── 部门分享面（结构面：判定时查部门成员，部门变动零 sweep；不走区间不落行）────
CREATE TABLE IF NOT EXISTS wiki_dept_share (
  wiki_id    UUID        NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  dept_id    UUID        NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wiki_id, dept_id)
);

-- ── 线性历史（每次内容 update 落一行；UI 后补）────────────────────────────────
CREATE TABLE IF NOT EXISTS wiki_revision (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wiki_id        UUID        NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  title          TEXT        NULL,
  body           TEXT        NOT NULL,
  mentions       JSONB       NOT NULL DEFAULT '[]',
  author_user_id UUID        NULL REFERENCES app_user(id),
  origin         TEXT        NOT NULL DEFAULT 'user',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wiki_revision_wiki_idx ON wiki_revision (wiki_id, created_at);

-- ── 索引补课（调研 §2.1：wiki_id 反查曾走全表；wiki.mentions 无 GIN；无全文索引）─
CREATE INDEX IF NOT EXISTS event_report_wiki_idx      ON event_report (wiki_id);
CREATE INDEX IF NOT EXISTS event_report_note_wiki_idx ON event_report_note (wiki_id);
CREATE INDEX IF NOT EXISTS wiki_mentions_idx          ON wiki USING GIN (mentions);
CREATE INDEX IF NOT EXISTS wiki_title_trgm_idx        ON wiki USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS wiki_body_trgm_idx         ON wiki USING GIN (body gin_trgm_ops);

-- ── W2 权限词汇：wiki 四动词（词汇行守卫幂等）──────────────────────────────────
-- 制作人通配区间 node:*/*@*（批G）自动覆盖新类型，无需模板 seed；
-- 默认角色不发 wiki 行（拍板 §4.7：默认不可见，分享/挂载驱动）
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('wiki', 'view', 0), ('wiki', 'create', 0), ('wiki', 'edit', 0), ('wiki', 'delete', 0)
ON CONFLICT DO NOTHING;

COMMIT;
