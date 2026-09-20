-- 素材上传资格区间回填（批D 收紧补偿，2026-09-01）。
--
-- 批D（migrate-asset-rest.sql）把上传门从裸门（成员即可传）收紧到
-- node:asset/*@create，迁移只映射了旧 asset:create 原子键——裸门时代无人
-- 需要持有该键，存量项目因此一行都没映射到。模版机制之前建的项目连
-- dept/role 区间也没有这枚键，六步链（grant → dept 区间 → role 区间 →
-- 个人区间 → 申请流）除 owner 旁路外全部落空：全员上传闭死，且无 UI 可
-- 自我确认解开（线上实况：10 个未归档项目零人持有上传键）。
--
-- 回填：对「任何 dept/role 区间都不含 node:asset/*@create」的项目，给其
-- 全部非弃用 role 补该区间行。补的是资格（可自我确认），不是直接访问权——
-- 与 permission/grant 二分模型一致，成员首次上传仍经激活面落个人 grant 行。
-- 模版建的项目区间已有键（含 film 收紧模版：至少一个 dept/role 持键），
-- 条件不命中，不受影响。幂等可重跑。
--
-- 跨 commit 自足守卫（词汇行，add-rest-verbs.sql 镜像）：
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('asset', 'create', 0)
ON CONFLICT DO NOTHING;

INSERT INTO production_role_permission (role_id, permission_key)
SELECT r.id, 'node:asset/*@create'
FROM production_role r
WHERE NOT r.is_deprecated
  AND NOT EXISTS (
    SELECT 1 FROM production_role_permission prp
    JOIN production_role r2 ON r2.id = prp.role_id
    WHERE r2.production_id = r.production_id
      AND prp.permission_key = 'node:asset/*@create'
  )
  AND NOT EXISTS (
    SELECT 1 FROM production_dept_permission pdp
    WHERE pdp.production_id = r.production_id
      AND pdp.permission_key = 'node:asset/*@create'
  )
ON CONFLICT DO NOTHING;
