-- Phase 5 收口（#158）：将 MEMBER_BASE_PERMISSIONS 补入所有现有 production_role
-- 原来这 10 个权限由代码中的 hasPermission() bypass 免检查直接放行。
-- 现在 bypass 已删除，权限必须通过 role → 免审批区间 → 用户点击"知道了" → grant 来生效。
-- 已有记录使用 ON CONFLICT DO NOTHING 跳过，幂等可重跑。

INSERT INTO production_role_permission (role_id, permission_key)
SELECT r.id, p.permission_key
FROM production_role r
CROSS JOIN (VALUES
  ('scene:view'),
  ('character:view'),
  ('script:view'),
  ('cue_list:view'),
  ('cue:view'),
  ('contacts:view'),
  ('event:follow'),
  ('asset:view'),
  ('asset:download'),
  ('asset:share')
) AS p(permission_key)
ON CONFLICT DO NOTHING;
