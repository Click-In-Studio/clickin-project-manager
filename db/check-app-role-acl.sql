-- 应用角色 ACL 硬闸。任一现有对象或未来对象默认权限不完整即退出非零。
\if :{?owner_role}
\else
  \set owner_role postgres
\endif
\if :{?app_role}
\else
  \set app_role script_editor
\endif
\set ON_ERROR_STOP on

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') AS missing_app_role \gset
\if :missing_app_role
  \echo '应用角色不存在：' :app_role
  SELECT 'ACL_GUARD_FAILED'::integer;
\endif

SELECT NOT has_schema_privilege(:'app_role', 'public', 'USAGE') AS missing_schema_usage \gset
\if :missing_schema_usage
  \echo '应用角色缺少 public schema USAGE：' :app_role
  SELECT 'ACL_GUARD_FAILED'::integer;
\endif

CREATE TEMP TABLE acl_missing_object(kind text, object_name text, missing_privileges text);

INSERT INTO acl_missing_object
SELECT 'table', relname,
       concat_ws(', ',
         CASE WHEN NOT has_table_privilege(:'app_role', oid, 'SELECT') THEN 'SELECT' END,
         CASE WHEN NOT has_table_privilege(:'app_role', oid, 'INSERT') THEN 'INSERT' END,
         CASE WHEN NOT has_table_privilege(:'app_role', oid, 'UPDATE') THEN 'UPDATE' END,
         CASE WHEN NOT has_table_privilege(:'app_role', oid, 'DELETE') THEN 'DELETE' END,
         CASE WHEN NOT has_table_privilege(:'app_role', oid, 'TRUNCATE') THEN 'TRUNCATE' END,
         CASE WHEN NOT has_table_privilege(:'app_role', oid, 'REFERENCES') THEN 'REFERENCES' END,
         CASE WHEN NOT has_table_privilege(:'app_role', oid, 'TRIGGER') THEN 'TRIGGER' END)
FROM (
  -- OFFSET 0 阻止规划器把 has_table_privilege 下推到 public 过滤之前。
  SELECT c.oid, c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  OFFSET 0
) objects
WHERE NOT (
  has_table_privilege(:'app_role', oid, 'SELECT')
  AND has_table_privilege(:'app_role', oid, 'INSERT')
  AND has_table_privilege(:'app_role', oid, 'UPDATE')
  AND has_table_privilege(:'app_role', oid, 'DELETE')
  AND has_table_privilege(:'app_role', oid, 'TRUNCATE')
  AND has_table_privilege(:'app_role', oid, 'REFERENCES')
  AND has_table_privilege(:'app_role', oid, 'TRIGGER')
);

INSERT INTO acl_missing_object
SELECT 'sequence', relname,
       concat_ws(', ',
         CASE WHEN NOT has_sequence_privilege(:'app_role', oid, 'USAGE') THEN 'USAGE' END,
         CASE WHEN NOT has_sequence_privilege(:'app_role', oid, 'SELECT') THEN 'SELECT' END,
         CASE WHEN NOT has_sequence_privilege(:'app_role', oid, 'UPDATE') THEN 'UPDATE' END)
FROM (
  SELECT c.oid, c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'S'
  OFFSET 0
) objects
WHERE NOT (
  has_sequence_privilege(:'app_role', oid, 'USAGE')
  AND has_sequence_privilege(:'app_role', oid, 'SELECT')
  AND has_sequence_privilege(:'app_role', oid, 'UPDATE')
);

TABLE acl_missing_object;
SELECT EXISTS (SELECT 1 FROM acl_missing_object) AS has_missing_objects \gset
\if :has_missing_objects
  \echo '应用角色存在对象 ACL 缺口：' :app_role
  SELECT 'ACL_GUARD_FAILED'::integer;
\endif

WITH expected(objtype, privilege_type) AS (
  VALUES
    ('r'::"char", 'SELECT'), ('r'::"char", 'INSERT'), ('r'::"char", 'UPDATE'),
    ('r'::"char", 'DELETE'), ('r'::"char", 'TRUNCATE'), ('r'::"char", 'REFERENCES'),
    ('r'::"char", 'TRIGGER'),
    ('S'::"char", 'USAGE'), ('S'::"char", 'SELECT'), ('S'::"char", 'UPDATE')
), actual AS (
  SELECT d.defaclobjtype AS objtype, upper(a.privilege_type) AS privilege_type
  FROM pg_default_acl d
  JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  JOIN pg_roles owner_role ON owner_role.oid = d.defaclrole
  JOIN pg_roles grantee_role ON grantee_role.oid = a.grantee
  WHERE n.nspname = 'public'
    AND owner_role.rolname = :'owner_role'
    AND grantee_role.rolname = :'app_role'
), missing AS (
  SELECT * FROM expected EXCEPT SELECT * FROM actual
)
SELECT EXISTS (SELECT 1 FROM missing) AS missing_default_privileges \gset

\if :missing_default_privileges
  \echo '应用角色缺少未来对象默认 ACL；owner=' :owner_role ' app=' :app_role
  SELECT 'ACL_GUARD_FAILED'::integer;
\endif

\echo '应用角色 ACL 完整；owner=' :owner_role ' app=' :app_role
