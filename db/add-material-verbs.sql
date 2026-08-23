-- material（物料台账）四动词入词汇表。
--
-- 线上事故（2026-08-20 错误日志）：项目模版 lib/templates/shared.ts 自
-- material 域接入起就发 node:material/* 键（基线 @view + 角色 @create/edit/delete），
-- 但 resource_permission_level 从未登记 material 行。模版键落进
-- production_role_permission（无 FK）不炸；角色实化成员 grant 行时撞
-- production_member_grant_level_fk，整个授权操作失败。
--
-- 正是 §0.9 定式账本纪律要防的坑：动自动授权写点必须同批登记词汇表。
-- 防复发：tests/conventions.test.ts 新增「模版键 resource_type ⊆ 词汇表」审计。
--
-- 受影响操作（当时整体回滚失败）在本文件应用后重试即可，无需数据回填。

INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('material', 'view', 0), ('material', 'create', 0), ('material', 'edit', 0), ('material', 'delete', 0)
ON CONFLICT DO NOTHING;
