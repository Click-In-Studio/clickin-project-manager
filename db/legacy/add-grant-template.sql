-- 权限REST化 批A：全局权限模板表（ROLE_TEMPLATE_PERMISSIONS 的 DB 镜像）。
--
-- permission 与 grant 的二分（总表 §0.8）：
--   permission = 免审批区间（资格），三张演出内表：
--     production_role_permission / production_dept_permission / production_member_permission
--   grant = 真正的访问权，单表 resource_grant（终局更名 production_member_grant）
--
-- 本表是纯**全局模板**：按 production_type（NULL=通用）× 角色名（'*'=所有成员的
-- 成员基础）定义默认资格集，仅在角色于 production_role_permission 无行时 fallback，
-- 以及未来创建演出/角色时 seed。演出内的实际资格一律在上述三张 permission 表。
--
-- permission_key 与三张 permission 表同词汇：原子键（迁移期）或树节点串
-- `node:<type>/<id>[/<sub>]@<verb>`（REST 化后）。
--
-- 以 postgres 用户执行：
--   psql -U postgres -d script_editor -f db/add-grant-template.sql

CREATE TABLE IF NOT EXISTS grant_template (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_type TEXT        NULL,      -- NULL = 通用模板
  role_name       TEXT        NOT NULL,  -- 角色名；'*' = 所有成员（member base）
  permission_key  TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS grant_template_unique_idx
  ON grant_template (COALESCE(production_type, ''), role_name, permission_key);

-- ── 全局通用模板种子：cue 域（保真迁移现行为） ─────────────────────────────────
-- 成员基础：目录可见 + 内容可见 + 可评论（原 MEMBER_BASE 的 cue_list:view/cue:view/cue:comment）
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('*', 'node:cue_list/*/meta@view'),
  ('*', 'node:cue_list/*/cues@view'),
  ('*', 'node:cue_list/*/cues/comments@create')
ON CONFLICT DO NOTHING;

-- 原 CUE_FULL_SET 九角色：集合 create 资格
INSERT INTO grant_template (role_name, permission_key)
SELECT r.name, 'node:cue_list/*@create'
FROM (VALUES ('音响设计'), ('灯光设计'), ('多媒体设计'), ('舞美设计'), ('服化设计'),
             ('舞台监督'), ('作曲'), ('编曲'), ('音乐导演')) AS r(name)
ON CONFLICT DO NOTHING;
