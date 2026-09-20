-- production_member 的 owner 行存量回填。
--
-- createProduction 一直只写 production.owner_id，从不写 production_member —— 而两条
-- 项目列表查询（listProductions / listMyProductionsWithRoles）只认成员行。以前建项目
-- 的人恒是 admin，两条查询对 admin 走全量分支，所以看不出来；#281 把创建放开给所有
-- 登录用户之后，owner 建完项目就从自己的列表里消失了（项目还在，owner_id 也对）。
--
-- 读路径已修为 LEFT JOIN + OR p.owner_id = $1，owner 没有成员行也看得见；这里把行补齐，
-- 好让 owner 出现在自己项目的成员名单里，与新建项目的行为一致（createProduction 现在
-- 会同时落这一行）。
--
-- 不给 roles：owner 的权限走 isOwner 旁路，这一行只表示「在不在项目里」，不授权。
-- 幂等（ON CONFLICT DO NOTHING），重复执行安全。

INSERT INTO production_member (production_id, user_id)
SELECT p.id, p.owner_id
FROM production p
WHERE p.owner_id IS NOT NULL
ON CONFLICT (production_id, user_id) DO NOTHING;
