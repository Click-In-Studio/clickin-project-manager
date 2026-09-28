-- migrate:up
ALTER TABLE production DROP COLUMN sort_order;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'irreversible'; END $$;
