-- AI 定时任务（2026-08-30 定谳，见 lib/agent-runtime/schedules.ts）。
--
-- 不是真 cron：一行任务 = 谁（创建者）在哪个制作（可空 = 个人）以什么时间表跑什么指令。
-- agent-runner 的节拍（60s）用租约式原子 UPDATE 认领到期行，到点以创建者身份**开一个新会话**
-- 跑一次 run（不打进创建它的会话：会撞 SessionBusy、污染对话、每次背整段 transcript），
-- 结果经站内通知只投给创建者。权限不快照：触发出的 run 与普通会话同构，工具内实时
-- hasEffectiveGrant——人被撤权/退出项目，下一次触发自然被拒，任务转 paused 并通知。
--
-- 无人值守写：**允许**，边界在 skills 内部（注册表 Def.unattended，缺省 deny）+ 本行
-- allowed_tools（创建时人在确认卡上圈定的工具清单）；每次写都进 agent_mutation 账本，
-- 通知里给改动清单——先做后审。
--
-- id 规约：TEXT PK + 带随机尾的 short id（lib/agent-runtime/ids.ts）。

CREATE TABLE IF NOT EXISTS agent_schedule (
  id                    TEXT        PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- NULL = 个人任务（my.* 语义）；非 NULL = 制作任务，触发前查成员资格与档位
  production_id         TEXT        NULL REFERENCES production(id) ON DELETE CASCADE,
  name                  TEXT        NOT NULL,
  prompt                TEXT        NOT NULL,           -- 每次触发作为用户消息送入的任务指令
  schedule              JSONB       NOT NULL,           -- {kind:'at',at} | {kind:'cron',expr,tz} | {kind:'every',everyMs}
  allowed_tools         TEXT[]      NOT NULL DEFAULT '{}', -- 允许无人值守直接写的工具 mcpName（须同时是注册表 unattended=allow）
  page_key              TEXT        NULL,               -- 创建时所在页面：温层工具面跟着来
  status                TEXT        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'paused', 'done')),
  paused_reason         TEXT        NULL,               -- 系统暂停的原因（不再是成员 / 档位未开 AI…）；人工暂停为 NULL
  next_fire_at          TIMESTAMPTZ NULL,               -- active 时非空；done/paused 时保留最后计划值
  last_fired_at         TIMESTAMPTZ NULL,
  last_run_id           TEXT        NULL REFERENCES agent_run(id) ON DELETE SET NULL,
  last_summary          TEXT        NULL,               -- 上次运行的结果摘要（≤1k，下次触发注入）
  fire_count            INTEGER     NOT NULL DEFAULT 0,
  max_fires             INTEGER     NULL,               -- 触发满即 done
  expires_at            TIMESTAMPTZ NULL,               -- 到期即 done
  -- 认领租约（同 agent_run.owner/heartbeat 的思路）：多实例 / 重启不重复触发
  lease_owner           TEXT        NULL,
  lease_until           TIMESTAMPTZ NULL,
  created_by_session_id TEXT        NULL REFERENCES agent_session(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_schedule_due_idx
  ON agent_schedule (next_fire_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS agent_schedule_user_idx
  ON agent_schedule (user_id, created_at DESC);

COMMENT ON TABLE agent_schedule IS
  'AI 定时任务。runner 节拍认领到期行 → 以创建者身份开新会话跑一次 run → 结果通知创建者。权限实时查、不快照。';

-- 触发出的会话 / run / 写审计都挂回任务：会话列表可标 ⏰、通知可列改动清单、审计页可按任务查
ALTER TABLE agent_session ADD COLUMN IF NOT EXISTS schedule_id TEXT NULL REFERENCES agent_schedule(id) ON DELETE SET NULL;
ALTER TABLE agent_run ADD COLUMN IF NOT EXISTS schedule_id TEXT NULL REFERENCES agent_schedule(id) ON DELETE SET NULL;
ALTER TABLE agent_mutation ADD COLUMN IF NOT EXISTS schedule_id TEXT NULL REFERENCES agent_schedule(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS agent_run_schedule_idx
  ON agent_run (schedule_id, started_at DESC)
  WHERE schedule_id IS NOT NULL;
-- 声明的两个访问面都要索引（AI review #399）：会话列表标 ⏰ / 触发会话自动归档扫描；审计页按任务查
CREATE INDEX IF NOT EXISTS agent_session_schedule_idx
  ON agent_session (schedule_id)
  WHERE schedule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_mutation_schedule_idx
  ON agent_mutation (schedule_id, created_at DESC)
  WHERE schedule_id IS NOT NULL;
