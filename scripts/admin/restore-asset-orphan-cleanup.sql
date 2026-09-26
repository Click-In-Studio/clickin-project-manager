-- 定向补偿，不执行 migration down，不删除 schema_migrations 历史。
-- psql -X -v ON_ERROR_STOP=1 --single-transaction -v snapshot="$(cat snapshot.json)" -f 本文件
-- 仅当原行仍等于本次撤销后的状态，且目标实体仍不存在时恢复；任何冲突整笔回滚。
SET LOCAL TIME ZONE 'UTC';
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
SELECT length(set_config('clickin.asset_cleanup_snapshot', :'snapshot', true)) AS snapshot_bytes;
-- compensation-body
LOCK TABLE asset, node IN SHARE MODE;
LOCK TABLE production_member_grant IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  backup jsonb := current_setting('clickin.asset_cleanup_snapshot')::jsonb;
  targets jsonb;
BEGIN
  IF backup->>'migration' IS DISTINCT FROM '20260926041043' THEN
    RAISE EXCEPTION 'wrong asset cleanup snapshot version';
  END IF;
  targets := backup->'targets';
  IF jsonb_typeof(targets) IS DISTINCT FROM 'array'
     OR md5(targets::text) IS DISTINCT FROM backup->>'digest' THEN
    RAISE EXCEPTION 'invalid asset cleanup snapshot digest';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(targets) s
    LEFT JOIN production_member_grant g ON g.id=(s->>'id')::uuid
    WHERE g.id IS NULL
       OR s->>'resource_type' IS DISTINCT FROM 'asset' OR s->>'resource_id'='*'
       OR s->>'is_revoked' IS DISTINCT FROM 'false'
       OR to_jsonb(g) IS DISTINCT FROM (s || '{"is_revoked":true,"revoked_reason":"manual"}'::jsonb)
       OR EXISTS (SELECT 1 FROM asset a WHERE a.id=s->>'resource_id')
       OR EXISTS (SELECT 1 FROM node n WHERE n.asset_id=s->>'resource_id')
  ) THEN
    RAISE EXCEPTION 'asset cleanup rows changed; refusing compensation';
  END IF;
  UPDATE production_member_grant g SET is_revoked=s.is_revoked,revoked_reason=s.revoked_reason
  FROM jsonb_populate_recordset(NULL::production_member_grant,targets) s WHERE g.id=s.id;
END $$;
