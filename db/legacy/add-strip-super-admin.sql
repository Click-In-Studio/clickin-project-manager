-- Strip is_super_admin from all users.
--
-- Super-admin status was originally synced from Feishu's tenant admin flag and
-- translated to isAdmin=true in the session, which triggers a blanket bypass in
-- hasPermission() for all non-root, non-sensitive permission checks. This means
-- any Feishu tenant admin bypasses the entire zone/self-confirm flow, causing
-- them to appear as already granted without ever going through approval.
--
-- This migration clears all is_super_admin flags so no one in production has
-- the bypass active. The bypass code path itself remains (isAdmin is still used
-- by ROOT_PERMISSIONS and legacy admin list APIs) but is no longer reachable
-- via organic Feishu login.
--
-- Dev elevation: use GET /api/dev/make-admin (dev env only) to temporarily
-- set isAdmin=true in the session cookie for manual testing.

UPDATE feishu_user SET is_super_admin = false WHERE is_super_admin = true;
