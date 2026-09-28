-- migrate:up

-- #761 expand：旧 publication@view 在运行时代码中曾同时代表预览和原件读取。
-- 新模型把它展开成明确的预览（meta/*@view）与下载（file@view）三行；保留原行供
-- N-1 代码使用，本版本不做 contract 删除。有效期照搬，来源标成 migrated。
CREATE TEMP TABLE asset_publication_view_recipients ON COMMIT DROP AS
SELECT production_id, user_id, resource_id,
       CASE WHEN bool_or(expires_at IS NULL) THEN NULL ELSE max(expires_at) END AS expires_at
FROM production_member_grant
WHERE resource_type = 'asset' AND resource_sub = 'publication'
  AND permission_level = 'view' AND NOT is_revoked
  AND (expires_at IS NULL OR expires_at > now())
GROUP BY production_id, user_id, resource_id;

-- 到期但未 sweep 的同键行会占用活跃唯一索引；只处理本次受益者的目标键。
UPDATE production_member_grant g SET is_revoked = true, revoked_reason = 'manual'
FROM asset_publication_view_recipients r
WHERE g.production_id = r.production_id AND g.user_id = r.user_id
  AND g.resource_type = 'asset' AND g.resource_id = r.resource_id
  AND g.resource_sub IN ('meta', '*', 'file') AND g.permission_level = 'view'
  AND NOT g.is_revoked AND g.expires_at <= now();

INSERT INTO production_member_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, expires_at)
SELECT r.production_id, r.user_id, 'asset', r.resource_id, s.sub,
       'view', 'migrated', r.expires_at
FROM asset_publication_view_recipients r
CROSS JOIN unnest(ARRAY['meta', '*', 'file']::text[]) AS s(sub)
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false DO NOTHING;

-- migrate:down

DO $$ BEGIN RAISE EXCEPTION 'irreversible'; END $$;
