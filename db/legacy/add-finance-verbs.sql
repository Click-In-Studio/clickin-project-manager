-- Finance permissions are emitted by every production template's shared
-- baseline. Register the resource type before those template keys are
-- materialized into production_member_grant rows (which have an FK here).
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('finance', 'view', 0), ('finance', 'create', 0), ('finance', 'edit', 0), ('finance', 'delete', 0)
ON CONFLICT DO NOTHING;
