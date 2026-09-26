-- 使用 psql -X -qAt -v ON_ERROR_STOP=1 --single-transaction，输出重定向到权限 600 的备份文件。
SET LOCAL TIME ZONE 'UTC';
SET LOCAL statement_timeout = '15s';
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
-- snapshot-query
WITH candidates AS (
  SELECT g.* FROM production_member_grant g
  WHERE g.resource_type = 'asset' AND g.resource_id <> '*'
    AND NOT g.is_revoked AND (g.expires_at IS NULL OR g.expires_at > now())
    AND g.created_at < timestamptz '2026-09-26 04:07:00+00'
    AND NOT EXISTS (SELECT 1 FROM asset a WHERE a.id = g.resource_id)
    AND NOT EXISTS (SELECT 1 FROM node n WHERE n.asset_id = g.resource_id)
), targets AS (
  SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]'::jsonb) AS rows FROM candidates c
), unaffected AS (
  SELECT 'grants' AS kind, to_jsonb(g) AS row FROM production_member_grant g
    WHERE NOT EXISTS (SELECT 1 FROM candidates c WHERE c.id=g.id)
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(NULLIF(
          current_setting('clickin.asset_cleanup_excluded_ids', true), ''), '[]')::jsonb) e(id)
        WHERE e.id=g.id::text
      )
  UNION ALL SELECT 'roles', to_jsonb(r) FROM production_role_permission r
  UNION ALL SELECT 'departments', to_jsonb(d) FROM production_dept_permission d
  UNION ALL SELECT 'members', to_jsonb(m) FROM production_member_permission m
  UNION ALL SELECT 'policies', to_jsonb(p) FROM production_policy p
  UNION ALL SELECT 'nodes', to_jsonb(n) FROM node n
  UNION ALL SELECT 'assets', to_jsonb(a) FROM asset a
)
SELECT jsonb_build_object(
  'migration', '20260926041043',
  'captured_at', now(),
  'targets', targets.rows,
  'count', jsonb_array_length(targets.rows),
  'digest', md5(targets.rows::text),
  'unchanged_digest', (SELECT md5(COALESCE(jsonb_agg(to_jsonb(u) ORDER BY u.kind,u.row::text)::text,'[]')) FROM unaffected u)
) AS snapshot FROM targets;
