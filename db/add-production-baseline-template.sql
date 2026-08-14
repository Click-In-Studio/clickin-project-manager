-- production 域基线模板（2026-08-13 用户定谳：权限越基线，修改该权限越敏感——
-- view 面是基线非 sensitive）。isSensitiveNode 的动词精确化同批代码修正。
-- 纯 seed，幂等。

BEGIN;

INSERT INTO grant_template (role_name, permission_key) VALUES
  ('*', 'node:production/*/meta@view'),
  ('*', 'node:production/*/mounts@view')
ON CONFLICT DO NOTHING;

COMMIT;
