-- migrate:up

ALTER TABLE asset
  ADD CONSTRAINT asset_type_check
    CHECK (asset_type IN (
      'drafting', 'planogram', 'demo', 'rehearsal_video', 'reference',
      'material', 'clip', 'qlab', 'score', 'recording', 'financial_document'
    )),
  ADD CONSTRAINT asset_financial_document_single_policy_check
    CHECK (asset_type <> 'financial_document' OR file_version_policy = 'single');

CREATE FUNCTION prevent_asset_file_policy_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.file_version_policy IS DISTINCT FROM OLD.file_version_policy THEN
    RAISE EXCEPTION 'asset file version policy is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'asset_file_version_policy_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER asset_file_version_policy_immutable
BEFORE UPDATE OF file_version_policy ON asset
FOR EACH ROW EXECUTE FUNCTION prevent_asset_file_policy_update();

CREATE FUNCTION prevent_asset_system_type_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (OLD.asset_type = 'financial_document') IS DISTINCT FROM
     (NEW.asset_type = 'financial_document') THEN
    RAISE EXCEPTION 'financial_document is a creation-only system asset type'
      USING ERRCODE = '23514', CONSTRAINT = 'asset_financial_document_type_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER asset_financial_document_type_immutable
BEFORE UPDATE OF asset_type ON asset
FOR EACH ROW EXECUTE FUNCTION prevent_asset_system_type_update();

CREATE FUNCTION enforce_asset_single_file_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_policy TEXT;
BEGIN
  -- 锁父行使两个并发 INSERT 串行；FK 继续负责不存在的 asset_id。
  SELECT file_version_policy INTO parent_policy
    FROM asset
   WHERE id = NEW.asset_id
   FOR UPDATE;

  IF parent_policy = 'single'
     AND EXISTS (SELECT 1 FROM asset_file WHERE asset_id = NEW.asset_id) THEN
    RAISE EXCEPTION 'single-file asset already has a file'
      USING ERRCODE = '23514', CONSTRAINT = 'asset_single_file_policy_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER asset_single_file_policy_guard
BEFORE INSERT ON asset_file
FOR EACH ROW EXECUTE FUNCTION enforce_asset_single_file_policy();

-- migrate:down

DROP TRIGGER IF EXISTS asset_single_file_policy_guard ON asset_file;
DROP FUNCTION IF EXISTS enforce_asset_single_file_policy();

DROP TRIGGER IF EXISTS asset_financial_document_type_immutable ON asset;
DROP FUNCTION IF EXISTS prevent_asset_system_type_update();

DROP TRIGGER IF EXISTS asset_file_version_policy_immutable ON asset;
DROP FUNCTION IF EXISTS prevent_asset_file_policy_update();

ALTER TABLE asset
  DROP CONSTRAINT asset_financial_document_single_policy_check,
  DROP CONSTRAINT asset_type_check;
