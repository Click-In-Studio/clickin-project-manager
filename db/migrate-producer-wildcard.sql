-- 权限REST化 批G G-1：制作人通配区间（模板收敛）。
--
-- 设计（用户同意方案，2026-08-13）：
--   制作人模板 = 全部免审批区间，通配表达——语义上的"全部"在机制上也是"全部"，
--   新增权限键永不需要补 migration。
--   主行 node:*/*@*（全类型全实例全 sub 全动词）+ 保留段显式四行
--   （保留段不被通配覆盖原则完好）。
--   RESERVED_TYPES=production/producer：类型通配不穿透治理域——制作人的治理
--   申请入口资格由显式 sensitive 节点串表达（本迁移不加：线上 role 表历史上
--   无治理键行——ROLE_TEMPLATE_EXCLUDED 在 seed 时已排除——保真=维持现状，
--   未来要给入口=模板加行，纯数据操作）。
--
-- 幂等，可重复执行。

BEGIN;

-- ── 1. grant_template '制作人' 收敛 ───────────────────────────────────────────
-- 删除被通配覆盖的枚举行（全部非治理类型的 node: 行）
DELETE FROM grant_template
WHERE role_name = '制作人'
  AND permission_key LIKE 'node:%'
  AND permission_key NOT LIKE 'node:production/%'
  AND permission_key NOT LIKE 'node:producer/%';

INSERT INTO grant_template (role_name, permission_key) VALUES
  ('制作人', 'node:*/*@*'),
  ('制作人', 'node:*/*/grants@*'),
  ('制作人', 'node:*/*/publication@*'),
  ('制作人', 'node:*/*/assignees@*'),
  ('制作人', 'node:*/*/imports@create')
ON CONFLICT DO NOTHING;

-- ── 2. 各演出 production_role_permission '制作人' role 收敛 ───────────────────
DELETE FROM production_role_permission prp
USING production_role pr
WHERE pr.id = prp.role_id AND pr.name = '制作人'
  AND prp.permission_key LIKE 'node:%'
  AND prp.permission_key NOT LIKE 'node:production/%'
  AND prp.permission_key NOT LIKE 'node:producer/%';

INSERT INTO production_role_permission (role_id, permission_key)
SELECT pr.id, k.key
FROM production_role pr
CROSS JOIN (VALUES
  ('node:*/*@*'), ('node:*/*/grants@*'), ('node:*/*/publication@*'),
  ('node:*/*/assignees@*'), ('node:*/*/imports@create')
) AS k(key)
WHERE pr.name = '制作人'
ON CONFLICT DO NOTHING;

COMMIT;
