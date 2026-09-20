-- 权限REST化 批G G-2：终局清理。
--
-- §0.5 终局判据落地：
--   1. atomic_permission_grant DROP（168 原子键六批全部退役，线上 0 行）
--   2. resource_grant → production_member_grant 更名（终局命名；索引同步更名）
--   3. 孤儿数据行清理（note:*_comment_any 2 枚——代码中不存在的历史残留）
--   4. dept.permissions[] / poc_extra / poc_blocked 数组列：判定机制已拆
--      （区间唯一源=permission 三表），物理列保留待后续清洁（线上全空）
--
-- 幂等，可重复执行。

BEGIN;

-- ── 1. 孤儿行清理 ─────────────────────────────────────────────────────────────
DELETE FROM production_role_permission
WHERE permission_key IN ('note:edit_comment_any', 'note:delete_comment_any');
DELETE FROM production_member_permission
WHERE permission IN ('note:edit_comment_any', 'note:delete_comment_any');
DELETE FROM production_dept_permission
WHERE permission_key IN ('note:edit_comment_any', 'note:delete_comment_any');

-- ── 2. atomic_permission_grant DROP ──────────────────────────────────────────
DROP TABLE IF EXISTS atomic_permission_grant;

-- ── 3. resource_grant → production_member_grant ──────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'resource_grant') THEN
    ALTER TABLE resource_grant RENAME TO production_member_grant;
  END IF;
END $$;

ALTER INDEX IF EXISTS resource_grant_active_unique_idx RENAME TO production_member_grant_active_unique_idx;
ALTER INDEX IF EXISTS resource_grant_lookup_idx RENAME TO production_member_grant_lookup_idx;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_grant_level_fk') THEN
    ALTER TABLE production_member_grant RENAME CONSTRAINT resource_grant_level_fk TO production_member_grant_level_fk;
  END IF;
END $$;

COMMIT;
