-- migrate:up
ALTER TABLE agent_session ADD COLUMN model_selection JSONB NOT NULL DEFAULT '{"modelKey":"deepseek-flash","thinkingLevel":"low","disabledSubagentModels":[]}'::jsonb;
ALTER TABLE agent_run ADD COLUMN model_selection JSONB NOT NULL DEFAULT '{"modelKey":"deepseek-flash","thinkingLevel":"low","disabledSubagentModels":[]}'::jsonb;
ALTER TABLE agent_run ADD COLUMN attachment_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
UPDATE agent_run SET model_selection=jsonb_set(model_selection,'{modelKey}','"deepseek-pro"') WHERE model='deepseek-v4-pro';
-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'irreversible'; END $$;
