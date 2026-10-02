-- migrate:up
ALTER TABLE production_material DROP COLUMN status_id;
DROP TABLE production_material_status;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'irreversible'; END $$;
