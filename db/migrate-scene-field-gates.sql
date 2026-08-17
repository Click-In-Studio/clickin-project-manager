-- scene 字段门对齐（2026-08-17）：模板键与判定键的错配收敛。
--
-- 背景（调研见 MindWeave《权限系统-激活面断层与scene编辑权限失效》）：
--   grant_template 给编剧 / 戏剧构作发的是 `node:scene/*/meta@edit`，而判定端
--   全部查 `meta/name`——nodeKeyCandidates 只生成「精确 sub」与「'*' 全通配」
--   两种候选，没有父 sub 的祖先语义，于是 meta@edit 永远命不中 meta/name@edit。
--   全库 14 行区间键（8 个演出 × 编剧/戏剧构作）自迁移以来一直空转：这两个
--   角色永久拿不到构作编辑与紧凑排版切换。
--
-- 本次对齐方向（用户 2026-08-17 定谳，C 案）：**判定端拆到字段级**，
--   scene PATCH 与 script patch 两条写入路径逐字段查键（SCENE_FIELD_SUBS /
--   MARKER_META_FIELD_KEYS），模板既有的字段级键（synopsis@edit / music@edit …）
--   由此真正生效。本文件补齐字段级模板里缺的四枚键，并清除空转的 meta@edit。
--
-- 补齐的四枚（编剧 / 戏剧构作）：
--   meta/name@edit              改场次 / 章节名（= 紧凑排版切换的同一把钥匙）
--   meta/type@edit              章节 ↔ 场次转换
--   meta/expected_duration@edit 预计时长（构作的节奏工作）
--   scene/*@edit                结构面：场次重排、块归属、场次号变动
--
-- 幂等，可重复执行。存量 grant 行不补——修复后各人进页面点一次激活弹窗即自愈
-- （self-confirm 的设计语义就是行必须由本人确认发行）。

BEGIN;

-- ── 0. 待补键（模板层 + 存量演出角色层共用同一份清单）────────────────────────
CREATE TEMP TABLE scene_field_keys (permission_key TEXT) ON COMMIT DROP;
INSERT INTO scene_field_keys VALUES
  ('node:scene/*/meta/name@edit'),
  ('node:scene/*/meta/type@edit'),
  ('node:scene/*/meta/expected_duration@edit'),
  ('node:scene/*@edit');

CREATE TEMP TABLE scene_field_roles (role_name TEXT) ON COMMIT DROP;
INSERT INTO scene_field_roles VALUES ('编剧'), ('戏剧构作');

-- ── 1. 全局模板（production_type IS NULL = 通用模板）─────────────────────────
INSERT INTO grant_template (role_name, permission_key)
SELECT r.role_name, k.permission_key
FROM scene_field_roles r CROSS JOIN scene_field_keys k
ON CONFLICT DO NOTHING;

-- ── 2. 存量演出的同名角色区间 ────────────────────────────────────────────────
-- 演出自治：模板只在创建时 seed，存量演出必须显式补行（总表 §0「grant_template
-- 运行时零读取」）。
INSERT INTO production_role_permission (role_id, permission_key)
SELECT pr.id, k.permission_key
FROM production_role pr
JOIN scene_field_roles r ON r.role_name = pr.name
CROSS JOIN scene_field_keys k
ON CONFLICT DO NOTHING;

-- ── 3. 清除空转的 meta@edit ──────────────────────────────────────────────────
-- 判定端从无 sub='meta' 的 edit 门；线上零 grant 行、零 dept/member 区间行
-- （2026-08-17 查证），只存在于模板与 role 区间两处。留着会让人误以为这两个
-- 角色持有 scene 元数据的编辑权。
DELETE FROM grant_template            WHERE permission_key = 'node:scene/*/meta@edit';
DELETE FROM production_role_permission WHERE permission_key = 'node:scene/*/meta@edit';
DELETE FROM production_dept_permission WHERE permission_key = 'node:scene/*/meta@edit';
DELETE FROM production_member_permission WHERE permission   = 'node:scene/*/meta@edit';

COMMIT;
