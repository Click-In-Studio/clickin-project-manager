-- Support multiple email bindings per account.
-- Each account can mark at most one email as primary (used for notifications).

ALTER TABLE user_platform_identity
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false;

-- Existing email identities become primary automatically.
UPDATE user_platform_identity
   SET is_primary = true
 WHERE platform_id = 'email';

-- Enforce at most one primary email per user.
CREATE UNIQUE INDEX IF NOT EXISTS upi_primary_email_uniq
  ON user_platform_identity(user_id)
  WHERE platform_id = 'email' AND is_primary = true;
