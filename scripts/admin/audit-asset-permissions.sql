-- #427 资产权限迁移前盘点。只读、聚合，不输出正文、外链令牌或个人联系方式。
-- 用法：psql -X -v ON_ERROR_STOP=1 -d script_editor -f scripts/admin/audit-asset-permissions.sql
-- 在线必须分别对 dev/prod 执行；本文件不包含修复或迁移写入。
\pset pager off
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT now() AS audited_at, current_database() AS database;
SELECT max(version) AS latest_migration, count(*) AS applied_migrations FROM schema_migrations;

SELECT resource_type, resource_sub, permission_level, resource_id='*' AS wildcard,
       CASE WHEN is_revoked THEN 'revoked' WHEN expires_at <= now() THEN 'expired' ELSE 'active' END AS validity,
       grant_source, count(*)
FROM production_member_grant WHERE resource_type IN ('asset','*')
GROUP BY 1,2,3,4,5,6 ORDER BY 1,2,3,4,5,6;

SELECT 'role' AS source, permission_key, count(*)
FROM production_role_permission WHERE permission_key ~ '^node:(asset|\*)/' GROUP BY 2
UNION ALL SELECT 'dept', permission_key, count(*)
FROM production_dept_permission WHERE permission_key ~ '^node:(asset|\*)/' GROUP BY 2
UNION ALL SELECT CASE WHEN granted THEN 'member_allow' ELSE 'member_deny' END, permission, count(*)
FROM production_member_permission WHERE permission ~ '^node:(asset|\*)/' GROUP BY 1,2
ORDER BY 1,2;

SELECT policy_key,value,count(*) FROM production_policy
WHERE policy_key LIKE '%asset%' OR policy_key='policy.share_token_enabled'
GROUP BY 1,2 ORDER BY 1,2;
SELECT is_public,listable,count(*) FROM node WHERE kind='asset' GROUP BY 1,2 ORDER BY 1,2;

SELECT 'asset_without_node' AS check_name, count(*) AS affected FROM asset a
WHERE NOT EXISTS (SELECT 1 FROM node n WHERE n.asset_id=a.id AND n.production_id=a.production_id)
UNION ALL SELECT 'node_without_asset', count(*) FROM node n WHERE n.kind='asset'
AND NOT EXISTS (SELECT 1 FROM asset a WHERE a.id=n.asset_id AND a.production_id=n.production_id)
UNION ALL SELECT 'active_grant_without_asset', count(*) FROM production_member_grant g
WHERE g.resource_type='asset' AND g.resource_id <> '*' AND NOT g.is_revoked
AND (g.expires_at IS NULL OR g.expires_at>now())
AND NOT EXISTS (SELECT 1 FROM asset a WHERE a.id=g.resource_id AND a.production_id=g.production_id);

SELECT g.permission_level AS legacy_action, count(*) AS without_manage
FROM production_member_grant g WHERE g.resource_type='asset' AND g.resource_sub='publication'
AND g.permission_level IN ('create','delete') AND NOT g.is_revoked
AND (g.expires_at IS NULL OR g.expires_at>now())
AND NOT EXISTS (
  SELECT 1 FROM production_member_grant m WHERE m.production_id=g.production_id AND m.user_id=g.user_id
  AND m.resource_type='asset' AND m.resource_id IN (g.resource_id,'*')
  AND m.resource_sub='grants' AND m.permission_level='edit' AND NOT m.is_revoked
  AND (m.expires_at IS NULL OR m.expires_at>now())
) GROUP BY 1 ORDER BY 1;

SELECT nm.mount_type,count(*) FROM node_mount nm JOIN node n ON n.id=nm.node_id
WHERE n.kind='asset' GROUP BY 1 ORDER BY 1;
SELECT count(*) AS asset_department_shares FROM node_dept_share ns JOIN node n ON n.id=ns.node_id WHERE n.kind='asset';
COMMIT;
