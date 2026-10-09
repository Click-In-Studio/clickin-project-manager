-- migrate:up

-- #884：制作级 AI 指令的设置页与 Agent 工具都以 edit 为真实权限门；
-- 先登记词汇，self-confirm 才能落 production_member_grant 行。
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order)
VALUES ('ai_instructions', 'edit', 0)
ON CONFLICT DO NOTHING;

-- migrate:down

-- grant 行上线后会通过复合外键引用该词汇，删除会破坏已发行权限。
DO $$ BEGIN
  RAISE EXCEPTION 'irreversible: ai_instructions grants may reference this permission vocabulary';
END $$;
