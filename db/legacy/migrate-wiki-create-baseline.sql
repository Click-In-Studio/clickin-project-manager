-- wiki 创建资格基线回填（W3 部署缺口修复，2026-08-16）。
--
-- add-wiki-create-template.sql 只 seed 了 grant_template ('*', 'node:wiki/*@create')，
-- 但 grant_template 运行时零读取（仅建剧组/建角色时经 seedRoleFromTemplate 展开）——
-- 存量剧组的 production_role_permission 无此键，普通成员实际上没有创建资格
-- （只有 admin/owner 与制作人通配可建文档）。
--
-- 回填：全部现存非弃用 role 补 'node:wiki/*@create' 区间行（与批B event 基线
-- 落法一致——全员基线=每个 role 一行）。幂等可重跑。
--
-- 跨 commit 自足守卫（依赖词汇行，add-wiki-library.sql 镜像）：
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('wiki', 'view', 0), ('wiki', 'create', 0), ('wiki', 'edit', 0), ('wiki', 'delete', 0)
ON CONFLICT DO NOTHING;

INSERT INTO production_role_permission (role_id, permission_key)
SELECT id, 'node:wiki/*@create'
FROM production_role
WHERE NOT is_deprecated
ON CONFLICT DO NOTHING;
