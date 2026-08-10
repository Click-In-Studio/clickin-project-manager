-- Per-resource individual person management (complements resource_dept_manage).
-- Used for approval routing: when a resource has no managing dept, a specific
-- person can be designated as approver instead.
-- Also used for atomic permission namespaces (resource_id = '*').
CREATE TABLE resource_person_manage (
  id             uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  production_id  text        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id        uuid        NOT NULL REFERENCES app_user(id)   ON DELETE CASCADE,
  resource_type  text        NOT NULL,
  resource_id    text        NOT NULL DEFAULT '*',
  resource_sub   text        NOT NULL DEFAULT '*',
  established_by uuid        NOT NULL REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (production_id, user_id, resource_type, resource_id, resource_sub)
);

CREATE INDEX rpm_production_resource_idx
  ON resource_person_manage (production_id, resource_type, resource_id);
