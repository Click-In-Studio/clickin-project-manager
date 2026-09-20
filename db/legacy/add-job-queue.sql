-- 后台重活任务队列（heavy-worker 进程消费）。
--
-- 动机（2026-09 服务器负载盘点）：pdf/docx 解析是同步阻塞的 CPU 重活，跑在 600M 的
-- agent-runner 里，OOM 重启会打断所有在跑的 run；sharp 缩略图同步跑在 next 请求里。
-- 两者都挪进独立 heavy-worker 进程，经此表派发。
--
-- 形态与 agent_schedule 的租约认领同款：worker 用原子 UPDATE + FOR UPDATE SKIP LOCKED
-- 认领，租约到期由 sweep 收回重排（attempts 用尽则终局 failed）。完成/终局经
-- pg_notify('job_done', id) 通知等待方（双模式：调用方短等 N 秒，超时转后台）；
-- 新任务经 pg_notify('job_new', id) 叫醒 worker，比纯轮询快一拍。
-- 未来商用化铺开后，集群子服务器就是"多个进程从同一张表认领"——调用方不感知。

CREATE TABLE IF NOT EXISTS job (
  id           TEXT        PRIMARY KEY,            -- jb_ 前缀短 id（lib/job/queue.ts）
  kind         TEXT        NOT NULL,               -- doc_parse | image_thumbnail | ...
  payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key   TEXT        NULL,                   -- 相同工作合流（如 doc_parse:pdf:<fileId>:v2）
  priority     INT         NOT NULL DEFAULT 0,     -- 大者先跑（预热类用负值让行）
  status       TEXT        NOT NULL DEFAULT 'queued',  -- queued | running | done | failed
  attempts     INT         NOT NULL DEFAULT 0,
  max_attempts INT         NOT NULL DEFAULT 3,
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(), -- 重试退避用
  lease_owner  TEXT        NULL,
  lease_until  TIMESTAMPTZ NULL,
  result       JSONB       NULL,                   -- 小结果直接放这（大产物放 R2，这里放键）
  error        TEXT        NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ NULL,
  finished_at  TIMESTAMPTZ NULL
);

-- 同一份工作最多一条在途行；并发 enqueue 靠它兜底（先查后插的窗口期）
CREATE UNIQUE INDEX IF NOT EXISTS job_dedupe_active_idx
  ON job (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

-- 认领扫描：status='queued' 的行按优先级/先来后到取
CREATE INDEX IF NOT EXISTS job_claim_idx
  ON job (priority DESC, created_at)
  WHERE status = 'queued';

-- 租约过期 sweep
CREATE INDEX IF NOT EXISTS job_lease_idx
  ON job (lease_until)
  WHERE status = 'running';

COMMENT ON TABLE job IS
  '后台重活任务队列：heavy-worker 租约认领执行（pdf/docx 解析、缩略图等）；完成经 pg_notify(job_done) 通知等待方';
