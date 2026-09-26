-- migrate:up
-- #427：旧模型中沿全 listable 父链的资产，持有效 meta@view 票即可读取内容。
-- 新模型把目录与内容分开；把这部分已经生效的读者转成资产实例正文授权。
-- 部门分享、挂载及非全 listable 父链不物化，它们在新判定中直接让渡内容。
CREATE TEMP TABLE asset_listed_read_recipients ON COMMIT DROP AS
WITH RECURSIVE listed AS (
  SELECT id, production_id, parent_id, asset_id, 1 AS depth
  FROM node WHERE parent_id IS NULL AND listable
  UNION ALL
  SELECT n.id, n.production_id, n.parent_id, n.asset_id, l.depth + 1
  FROM node n JOIN listed l ON n.parent_id = l.id AND n.production_id = l.production_id
  WHERE n.listable AND l.depth < 100
)
SELECT l.production_id, g.user_id, l.asset_id,
  CASE WHEN bool_or(g.expires_at IS NULL) THEN NULL ELSE max(g.expires_at) END AS expires_at
FROM listed l
JOIN asset a ON a.id = l.asset_id AND a.production_id = l.production_id
JOIN production_member_grant g ON g.production_id = l.production_id
  AND g.resource_type = 'asset' AND g.resource_id IN (l.asset_id, '*')
  AND g.resource_sub IN ('meta', '*') AND g.permission_level = 'view'
  AND NOT g.is_revoked AND (g.expires_at IS NULL OR g.expires_at > now())
WHERE l.asset_id IS NOT NULL
GROUP BY l.production_id, g.user_id, l.asset_id;

-- 过期但尚未 sweep 的同键行占用部分唯一索引；只对本次受益者撤销失效旧行。
UPDATE production_member_grant g SET is_revoked = true, revoked_reason = 'manual'
FROM asset_listed_read_recipients r
WHERE g.production_id = r.production_id AND g.user_id = r.user_id
  AND g.resource_type = 'asset' AND g.resource_id = r.asset_id
  AND g.resource_sub = '*' AND g.permission_level = 'view'
  AND NOT g.is_revoked AND g.expires_at <= now();

INSERT INTO production_member_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, expires_at)
SELECT production_id, user_id, 'asset', asset_id, '*', 'view', 'migrated', expires_at
FROM asset_listed_read_recipients
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false DO NOTHING;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'irreversible'; END $$;
