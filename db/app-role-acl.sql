-- 应用角色 ACL 对账（幂等）。由 CD 在 migration 后、切换 release 前以对象 owner 执行。
--
-- 可覆盖角色名供 CI 隔离验证；生产缺省值对应实际拓扑。
\if :{?owner_role}
\else
  \set owner_role postgres
\endif
\if :{?app_role}
\else
  \set app_role script_editor
\endif
\set ON_ERROR_STOP on

SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_role') \gexec
SELECT format(
  'GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO %I',
  :'app_role'
) \gexec
SELECT format(
  'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I',
  :'app_role'
) \gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO %I',
  :'owner_role', :'app_role'
) \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
  :'owner_role', :'app_role'
) \gexec
