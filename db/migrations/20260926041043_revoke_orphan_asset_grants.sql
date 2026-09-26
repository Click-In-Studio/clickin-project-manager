-- migrate:up
-- #427：只撤销盘点开始前、资产与壳均不存在的有效实例授权；保留原行作审计。
-- 通配票、已撤销/过期行和仍有实体（含跨项目错配）的行都不在本次清洗范围。
-- 线上运行用 options 设置 clickin.asset_cleanup_digest，快照后候选变化即中止。
SET LOCAL TIME ZONE 'UTC';
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
LOCK TABLE asset, node IN SHARE MODE;
LOCK TABLE production_member_grant IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  targets jsonb;
  expected text := current_setting('clickin.asset_cleanup_digest', true);
  affected integer;
BEGIN
  SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.id), '[]'::jsonb) INTO targets
  FROM production_member_grant g
  WHERE g.resource_type = 'asset' AND g.resource_id <> '*'
    AND NOT g.is_revoked AND (g.expires_at IS NULL OR g.expires_at > now())
    AND g.created_at < timestamptz '2026-09-26 04:07:00+00'
    AND NOT EXISTS (SELECT 1 FROM asset a WHERE a.id = g.resource_id)
    AND NOT EXISTS (SELECT 1 FROM node n WHERE n.asset_id = g.resource_id);

  IF expected IS NOT NULL AND expected <> '' AND md5(targets::text) <> expected THEN
    RAISE EXCEPTION 'asset cleanup candidates changed since snapshot';
  END IF;

  UPDATE production_member_grant g SET is_revoked = true, revoked_reason = 'manual'
  WHERE g.id IN (SELECT (value->>'id')::uuid FROM jsonb_array_elements(targets));
  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE NOTICE 'revoked historical orphan asset grants: %', affected;
END $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'irreversible'; END $$;
