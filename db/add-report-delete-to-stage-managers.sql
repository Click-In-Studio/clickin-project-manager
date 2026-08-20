-- 舞监 role 补 node:report/*@delete（#236 张力 4c，2026-08-18）
--
-- 背景：event / report 两条 DELETE 路由此前查的是 `grants@edit`（授权权），
-- 而不是 delete 动词——于是 `event/<id>/*@delete` 与 `report/<id>/*@delete` 是
-- **死动词**，删除权被绑在授权权上（一条违反 M-2 的隐式蕴含：能转授 ⟹ 能删）。
-- 同批把两条门改成查 delete 动词后，必须先保证**持钥人存在**，否则中间态是
-- 除 owner / 制作人外谁也删不了报告。
--
-- 设计定的默认持钥人：event → 制作人（已有 node:*/*@* 五行永久全集，无需补）；
-- report → 舞监。本文件补的就是后者。
--
-- 两处都要写，缺一不可：
--   1. grant_template —— 全局模板，**只在建演出/建角色时 seed**，运行时零读取。
--      只写它，存量演出一行也拿不到。
--   2. production_role_permission —— 存量演出各自的免审批区间。补进去之后，
--      舞监走「激活面点一下 → 落 grant 行」的正常管线拿到实际权限。
--
-- 幂等（两处都 ON CONFLICT DO NOTHING），可重复执行。

-- ── 1. 模板（管此后新建的演出）────────────────────────────────────────────────
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('舞台监督',     'node:report/*@delete'),
  ('助理舞台监督', 'node:report/*@delete'),
  ('后台舞台监督', 'node:report/*@delete')
ON CONFLICT DO NOTHING;

-- ── 2. 存量演出的免审批区间（管已经建好的演出）──────────────────────────────
-- 按 role 名匹配：ROLE_NAMES 是默认模版名单不是白名单，剧组可能自定义了名字，
-- 故只补这三个标准名下的角色，改过名的由人工处理（宁可漏补，不要乱发删除权）。
INSERT INTO production_role_permission (role_id, permission_key)
SELECT r.id, 'node:report/*@delete'
FROM production_role r
WHERE r.name IN ('舞台监督', '助理舞台监督', '后台舞台监督')
ON CONFLICT DO NOTHING;
