-- wiki 文档库 W3：全员创建资格模板。
--
-- 拍板 §4.7 只锁"默认不可见"（读面）；创建面走协作库常规（飞书/Notion：成员可建文档）。
-- 机制：'*' 全局模板 → 六步链 role 区间资格 → self-confirm 激活个人行
-- （wiki 页面激活面 scope 已在 W2 就位：node:wiki/*@create）。
-- 制作人通配区间已覆盖，无需另发。
--
-- 幂等，可重复执行。纯 seed 数据，无 DDL。

INSERT INTO grant_template (role_name, permission_key) VALUES
  ('*', 'node:wiki/*@create')
ON CONFLICT DO NOTHING;
