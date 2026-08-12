-- Script comment and rehearsal preference data backfill.
-- Depends on: production, production_role, production_role_permission, grant_template.
-- Adds comment eligibility to existing roles and stores the rehearsal-mark default for
-- existing productions that have not made an explicit choice.

BEGIN;

INSERT INTO production_role_permission (role_id, permission_key)
SELECT id, 'script:comment'
FROM production_role
ON CONFLICT DO NOTHING;

INSERT INTO grant_template (role_name, permission_key)
VALUES ('*', 'script:comment')
ON CONFLICT DO NOTHING;

UPDATE production
SET script_config = script_config || jsonb_build_object(
  'useRehearsalMarks',
  CASE
    WHEN type IN ('stage_play', 'short_film', 'film', 'tv_drama') THEN false
    ELSE true
  END
)
WHERE NOT (script_config ? 'useRehearsalMarks');

COMMIT;
