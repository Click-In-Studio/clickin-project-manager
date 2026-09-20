-- Allow 'atomic_permission' as an approval_request type,
-- enabling the approval flow to grant atomic permissions (not just resource grants).
ALTER TABLE approval_request DROP CONSTRAINT approval_request_type_check;
ALTER TABLE approval_request ADD CONSTRAINT approval_request_type_check
  CHECK (type = ANY (ARRAY[
    'resource_access'::text,
    'member_exit'::text,
    'owner_transfer'::text,
    'atomic_permission'::text
  ]));
