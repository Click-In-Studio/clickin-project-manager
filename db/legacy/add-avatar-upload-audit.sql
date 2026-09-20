-- 头像上传审计账本（PR #419 孤儿对象对策）。
--
-- 背景：头像改为版本化 R2 key（每次上传 presign 新 key），上传后未提交
-- （放弃/崩溃）的对象没有任何 DB 引用，无人触发清理。策略是不做自动 GC，
-- 但 presign 即记账、PATCH 提交标记 committed、清旧标记 deleted——孤儿
-- 因此永远查得出来，可手动清理：
--
--   SELECT r2_key, kind, subject_id, created_at FROM avatar_upload_audit
--   WHERE committed_at IS NULL AND deleted_at IS NULL
--     AND created_at < now() - interval '7 days';
--
-- 删掉对象后 UPDATE ... SET deleted_at = now() 平账。

CREATE TABLE IF NOT EXISTS avatar_upload_audit (
  id           TEXT        PRIMARY KEY,   -- ava_ 前缀 short id（仓库 id 规约）
  r2_key       TEXT        NOT NULL,
  kind         TEXT        NOT NULL CHECK (kind IN ('user', 'production')),
  subject_id   TEXT        NOT NULL,      -- kind=user 时为 app_user.id，production 时为 production.id
  uploader_id  UUID        NOT NULL REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at TIMESTAMPTZ,               -- PATCH 把该 key 写进 avatar_url 时标记
  deleted_at   TIMESTAMPTZ                -- R2 对象（原图+变体）删除成功时标记
);

-- 提交/清理都按 r2_key 找行
CREATE INDEX IF NOT EXISTS idx_avatar_upload_audit_r2_key
  ON avatar_upload_audit (r2_key);

-- 孤儿巡查走这条部分索引
CREATE INDEX IF NOT EXISTS idx_avatar_upload_audit_orphan
  ON avatar_upload_audit (created_at)
  WHERE committed_at IS NULL AND deleted_at IS NULL;
