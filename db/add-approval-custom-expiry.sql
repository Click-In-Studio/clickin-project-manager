-- 自定义审批有效期：固定档位继续存 ttl_duration；自定义日期存绝对时间，
-- 避免“提交到批准之间的等待时长”把用户选定的到期日整体向后平移。

ALTER TABLE approval_request
  ADD COLUMN IF NOT EXISTS requested_expires_at TIMESTAMPTZ NULL;

ALTER TABLE approval_request
  DROP CONSTRAINT IF EXISTS approval_request_ttl_duration_required;

ALTER TABLE approval_request
  ADD CONSTRAINT approval_request_ttl_duration_required
    CHECK (
      grant_type IS DISTINCT FROM 'ttl'
      OR ttl_duration IS NOT NULL
      OR requested_expires_at IS NOT NULL
    );

ALTER TABLE approval_request
  DROP CONSTRAINT IF EXISTS approval_request_ttl_source_exclusive;

ALTER TABLE approval_request
  ADD CONSTRAINT approval_request_ttl_source_exclusive
    CHECK (ttl_duration IS NULL OR requested_expires_at IS NULL);
