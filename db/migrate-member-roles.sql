-- Phase 2 (#137): production_member_role 关联表
-- 用 role_id FK 替代 production_member.roles TEXT[] 字符串数组，消除角色重命名时的静默断链。
-- production_member.roles TEXT[] 保留至 Phase 3 确认无问题后 DROP。

-- 1. 建表
CREATE TABLE IF NOT EXISTS production_member_role (
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role_id       TEXT NOT NULL REFERENCES production_role(id) ON DELETE CASCADE,
  PRIMARY KEY (production_id, user_id, role_id)
);

CREATE INDEX IF NOT EXISTS pmr_user_prod_idx
  ON production_member_role (production_id, user_id);

-- 2. 迁移数据：将 production_member.roles TEXT[] 映射到对应 production_role.id
--    只迁移在 production_role 中有匹配记录的 role 名称；
--    无匹配的 role 字符串（孤儿/已删除职位）忽略，不阻断迁移。
INSERT INTO production_member_role (production_id, user_id, role_id)
SELECT pm.production_id, pm.user_id, pr.id
FROM production_member pm
JOIN production_role pr
  ON pr.production_id = pm.production_id
 AND pr.name = ANY(pm.roles)
ON CONFLICT DO NOTHING;
