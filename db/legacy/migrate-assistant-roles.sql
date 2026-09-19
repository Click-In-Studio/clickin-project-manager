-- Phase 6: 将复合职位（助理类、副职）拆分为 base role + tag。
-- 复合行保留并标记 is_deprecated=true（不删除，保持 FK 引用稳定）。
-- 幂等性：INSERT ... ON CONFLICT DO NOTHING；重复执行安全。
--
-- 拆分规则（按名称后缀/前缀匹配）：
--   "X助理"         → role=X  + tag="助理"
--   "助理X"（助理舞台监督等） → role=X  + tag="助理"
--   "副X"           → role=X  + tag="副"
--
-- 本 migration 仅处理以下已知复合 role 名称，不做通配替换：
--   导演助理、助理舞台监督、副导演、音乐导演助理、作曲助理、
--   多媒体设计助理、服化设计助理、灯光设计助理、舞美设计助理、音响设计助理

BEGIN;

-- ── 1. 确保 "助理" / "副" 系统 tag 已存在 ────────────────────────────────────

INSERT INTO production_member_tag (name, is_system)
VALUES ('助理', true), ('副', true)
ON CONFLICT DO NOTHING;

-- ── 2. 为每个演出的复合 role，确保拆分后的 base role 存在 ────────────────────

-- 使用临时映射表：(composite_name → base_name, tag_name)
CREATE TEMP TABLE _role_split_map (
  composite TEXT PRIMARY KEY,
  base      TEXT NOT NULL,
  tag       TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO _role_split_map VALUES
  ('导演助理',    '导演',     '助理'),
  ('助理舞台监督', '舞台监督',  '助理'),
  ('副导演',     '导演',     '副'),
  ('音乐导演助理', '音乐导演',  '助理'),
  ('作曲助理',    '作曲',     '助理'),
  ('多媒体设计助理','多媒体设计','助理'),
  ('服化设计助理', '服化设计',  '助理'),
  ('灯光设计助理', '灯光设计',  '助理'),
  ('舞美设计助理', '舞美设计',  '助理'),
  ('音响设计助理', '音响设计',  '助理');

-- 为每个拥有复合 role 的演出，确保 base role 行存在
-- ID 由 (production_id, base_name) 的 md5 确定，确保幂等
INSERT INTO production_role (id, production_id, name)
SELECT
  'pr_' || substring(md5(pr.production_id || '::base::' || m.base), 1, 16),
  pr.production_id,
  m.base
FROM production_role pr
JOIN _role_split_map m ON m.composite = pr.name
WHERE pr.is_deprecated = false
ON CONFLICT (production_id, name) DO NOTHING;

-- ── 3. 将成员从复合 role 迁移到 base role ────────────────────────────────────

-- 3a. production_member_role（FK 路径）
INSERT INTO production_member_role (production_id, user_id, role_id)
SELECT
  pmr.production_id,
  pmr.user_id,
  base_pr.id
FROM production_member_role pmr
JOIN production_role composite_pr
  ON composite_pr.id = pmr.role_id
JOIN _role_split_map m ON m.composite = composite_pr.name
JOIN production_role base_pr
  ON base_pr.production_id = pmr.production_id
 AND base_pr.name = m.base
ON CONFLICT DO NOTHING;

-- 3b. production_member.roles TEXT[]（同步旧字段）
-- 将复合名替换为 base 名（若 base 名尚未在数组中则追加）
UPDATE production_member pm
SET roles = (
  SELECT array_agg(DISTINCT new_role ORDER BY new_role)
  FROM (
    SELECT r AS new_role
    FROM unnest(pm.roles) AS r
    WHERE r NOT IN (SELECT composite FROM _role_split_map)
    UNION
    SELECT m.base
    FROM unnest(pm.roles) AS r
    JOIN _role_split_map m ON m.composite = r
  ) sub
)
WHERE EXISTS (
  SELECT 1
  FROM unnest(pm.roles) AS r
  JOIN _role_split_map m ON m.composite = r
);

-- ── 4. 添加 tag 分配 ─────────────────────────────────────────────────────────

INSERT INTO production_member_tag_assignment (production_id, user_id, tag_id)
SELECT DISTINCT
  pmr.production_id,
  pmr.user_id,
  pmt.id
FROM production_member_role pmr
JOIN production_role pr ON pr.id = pmr.role_id
JOIN _role_split_map m ON m.composite = pr.name
JOIN production_member_tag pmt ON pmt.name = m.tag AND pmt.is_system = true
ON CONFLICT DO NOTHING;

-- ── 5. 标记复合 role 为 deprecated ──────────────────────────────────────────

UPDATE production_role
SET is_deprecated = true
WHERE name IN (SELECT composite FROM _role_split_map)
  AND is_deprecated = false;

COMMIT;
