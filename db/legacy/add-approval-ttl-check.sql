-- #256 兜底：'ttl' 时效必须带时长。
--
-- 缺这条约束时，grant_type='ttl' + ttl_duration=NULL 会静默通过，批准时
-- expires_at 落 NULL，而 NULL 在每一处权限检查里都等于永久 —— 申请人和审批人
-- 都以为是临时授权，实际发出去的是永久权限，且不会被 TTL 回收流程清理。
--
-- 前端（TTL_OPTIONS）与服务端（isValidTtlInterval）已各自拦一道，这里是第三道：
-- 任何绕过表单和路由的写入路径也捅不出这个组合。
-- 线上存量核对（2026-08-17）：违约行 0 条，无需清洗。

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'approval_request_ttl_duration_required'
      AND table_name = 'approval_request'
  ) THEN
    ALTER TABLE approval_request
      ADD CONSTRAINT approval_request_ttl_duration_required
      CHECK (grant_type IS DISTINCT FROM 'ttl' OR ttl_duration IS NOT NULL);
  END IF;
END $$;
