-- 权限REST化 批A：行集模板表（总表 §0.7 三层管线的"模板/资格"层）。
--
-- 两级模板：
--   全局模板   production_id IS NULL，holder_name 定位（角色名，'*' = 所有成员的基础行）；
--              production_type 可空——NULL=通用模板，未来按 production.type 建专属模板集
--   演出级模板 production_id 非空，holder_id 定位（production_role.id / production_dept.id::text）
--
-- 覆盖语义（沿用现行 production_role_permission fallback）：某 holder 在演出级有
-- 任何行 → 只用演出级；否则回落全局（按角色名匹配）。dept 无全局模板（部门是演出私有概念）。
--
-- 模板行只是"资格"：生效仍需 self-confirm 写 resource_grant 个人行（§0.7 激活层）。
-- dept 模板行沿 dept 树向下生效（伞语义：父组行覆盖子部门成员）。
--
-- 以 postgres 用户执行：
--   psql -U postgres -d script_editor -f db/add-grant-template.sql

CREATE TABLE IF NOT EXISTS grant_template (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NULL REFERENCES production(id) ON DELETE CASCADE,
  production_type TEXT        NULL,  -- 仅全局模板可用；NULL=通用
  holder_type     TEXT        NOT NULL CHECK (holder_type IN ('role', 'dept')),
  holder_id       TEXT        NULL,  -- 演出级：production_role.id / production_dept.id::text
  holder_name     TEXT        NULL,  -- 全局：角色名；'*' = 所有成员（member base）
  resource_type   TEXT        NOT NULL,
  resource_id     TEXT        NOT NULL DEFAULT '*',
  resource_sub    TEXT        NOT NULL DEFAULT '*',
  verb            TEXT        NOT NULL CHECK (verb IN ('view', 'create', 'edit', 'delete')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 全局模板按名字定位、演出级按 id 定位，二者互斥
  CHECK ((production_id IS NULL AND holder_id IS NULL AND holder_name IS NOT NULL)
      OR (production_id IS NOT NULL AND holder_id IS NOT NULL AND holder_name IS NULL)),
  -- dept 是演出私有概念，无全局模板
  CHECK (holder_type != 'dept' OR production_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS grant_template_global_unique_idx
  ON grant_template (holder_type, holder_name, COALESCE(production_type, ''), resource_type, resource_id, resource_sub, verb)
  WHERE production_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS grant_template_prod_unique_idx
  ON grant_template (production_id, holder_type, holder_id, resource_type, resource_id, resource_sub, verb)
  WHERE production_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS grant_template_prod_lookup_idx
  ON grant_template (production_id, holder_type, holder_id)
  WHERE production_id IS NOT NULL;

-- ── 全局通用模板种子：cue 域（保真迁移现行为） ─────────────────────────────────
-- 成员基础（原 MEMBER_BASE 的 cue_list:view + cue:view + cue:comment）：
--   目录可见 + 内容可见 + 可评论——与现行为一致（激活后全员可看全部 cue 表）
INSERT INTO grant_template (holder_type, holder_name, resource_type, resource_id, resource_sub, verb) VALUES
  ('role', '*', 'cue_list', '*', 'meta',          'view'),
  ('role', '*', 'cue_list', '*', 'cues',          'view'),
  ('role', '*', 'cue_list', '*', 'cues/comments', 'create')
ON CONFLICT DO NOTHING;

-- 原 CUE_FULL_SET 角色（音响设计/灯光设计/多媒体设计/舞台监督等经 ROLE_TEMPLATE_PERMISSIONS
-- 获得 cue 全套写权限的角色）：迁移为集合 create + 全实例写行集。
-- 注意：创建后对"自己创建的表"的控制来自创建时自动行集（§0.6），不来自模板；
-- 此处通配写行对应原 base 键经激活后作用于全部表的现实（原 hasScopedPermission 的
-- base∧isCreator 已由自动行集承担，模板通配行承担的是原 _any 之下、base 之上的
-- "对本域资源的普遍写能力"——与现行为对齐：base 键激活后 PATCH 由 hasListAccess
-- （per-list grant）真实把关，模板行不放大实际权限面）。
INSERT INTO grant_template (holder_type, holder_name, resource_type, resource_id, resource_sub, verb)
SELECT 'role', r.name, t.rtype, t.rid, t.rsub, t.verb
FROM (VALUES ('音响设计'), ('灯光设计'), ('多媒体设计'), ('舞美设计'), ('服化设计'),
             ('舞台监督'), ('作曲'), ('编曲'), ('音乐导演')) AS r(name)
CROSS JOIN (VALUES
  ('cue_list', '*', '*', 'create')
) AS t(rtype, rid, rsub, verb)
ON CONFLICT DO NOTHING;
