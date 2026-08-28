# 自建 AI 运行时（agent-runtime）运维手册

对应 issue #367 与 MindWeave《AI运行时自建-薄harness设计》。本文只写**怎么跑、怎么切、怎么回滚**；
设计意图看提案，代码地图看 `lib/agent-runtime/`。`docs/TOOL_SURFACE.md`（toolSearch 路线）已被本方案取代，留作历史。

## 组成

| 部件 | 位置 | 说明 |
|---|---|---|
| vendor 核心 | `vendor/openclaw/packages/{agent-core,llm-core}` | 上游 v2026.7.1-2，三处本地补丁见 `vendor/openclaw/VENDOR.md` |
| provider/流式 | `@openclaw/ai@2026.7.1-2`（npm 锁精确版本） | 与 vendor 同一上游版本 |
| run 服务 | `lib/agent-runtime/service.ts` | 一轮 run 的骨架：注入链 → harness → 事件 → 收尾 |
| 独立进程 | `agent-runner/index.ts` | loopback HTTP：`POST /runs` `/runs/steer` `/runs/abort`、`GET /health`；心跳、孤儿接管、SIGTERM 排水 |
| next 侧 | `lib/agent-runtime/{client,dispatch}.ts` + `app/api/agent/*` 路由 | 按会话分流网关/自建；SSE 从 `agent_event` 直出 |
| 持久化 | `db/add-agent-runtime.sql`（六表） | 会话/transcript/run/审批/提问/事件 |

## 环境变量

| 变量 | 值 | 说明 |
|---|---|---|
| `AGENT_RUNTIME` | `gateway`（默认）/ `runner` / `canary` | 分流总开关。已存在于 `agent_session` 的会话永远走 runner（网关没有它的 transcript） |
| `AGENT_RUNTIME_PRODUCTIONS` | 逗号分隔 production id，或 `*` | `canary` 时哪些制作走 runner（§4.5 按 production 灰度） |
| `AGENT_RUNTIME_PERSONAL` | `1` | `canary` 时个人会话也走 runner |
| `AGENT_RUNNER_URL` | `http://127.0.0.1:3102` | 设了 → next 把 run 交给独立进程；不设 → next 进程内跑（测试/灰度首期） |
| `AGENT_RUNNER_PORT` | 默认 `3102` | runner 监听端口（loopback） |
| `AGENT_CHAT_MODEL` / `AGENT_COMPACTION_MODEL` | 默认 `deepseek-v4-flash` / `deepseek-v4-pro` | 对话 / transcript 压缩摘要 |
| `DEEPSEEK_API_KEY` | | 与蒸馏共用（`.env.local`） |
| `AGENT_TOOL_TIERS` | `off` | 关闭工具三层（全量工具），排障用 |
| `AGENT_DRAIN_TIMEOUT_MS` | 默认 600000 | 排水上限 |
| `AGENT_HEARTBEAT_MS` / `AGENT_ORPHAN_AFTER_MS` | 默认 5000 / 30000 | 租约心跳 / 判孤儿 |
| `AGENT_APPROVAL_TTL_MS` / `AGENT_QUESTION_TTL_MS` | 默认 10min / 15min | 审批 / 提问过期 |

## 本地跑

```bash
# 进程内模式（最简单）
AGENT_RUNTIME=runner npm run dev

# 独立进程模式
npx tsx agent-runner/index.ts                                  # 终端 1
AGENT_RUNTIME=runner AGENT_RUNNER_URL=http://127.0.0.1:3102 npm run dev   # 终端 2

# 不开浏览器的冒烟：造用户/制作/cookie/sessionKey
npx tsx scripts/agent-runtime-smoke-setup.ts     # 打印 export COOKIE=… KEY=…
curl -sN --noproxy '*' -H "Cookie: $COOKIE" -H 'Content-Type: application/json' \
  -X POST http://127.0.0.1:3000/api/agent/chat/stream \
  -d "{\"sessionKey\":\"$KEY\",\"message\":\"我参与了哪些制作？\"}"
```

## 服务器部署（S3 灰度）

1. DDL：`db/add-agent-runtime.sql` 由 CD 自动执行（查 `shared/db-applied.txt`）。
2. pm2：在 `shared/ecosystem.config.js` 加一个 app（与 `production-manager` 同 env 文件）：
   ```js
   {
     name: "agent-runner",
     cwd: "/var/www/production-manager/current",
     script: "node_modules/.bin/tsx",
     args: "agent-runner/index.ts",
     env: { AGENT_RUNNER_PORT: "3102" },
     wait_ready: true,        // 进程 listen 后 process.send("ready")
     kill_timeout: 660000,    // ≥ AGENT_DRAIN_TIMEOUT_MS + 余量：SIGTERM 后给足排水时间
     max_memory_restart: "700M",
   }
   ```
   `pm2 reload agent-runner`：新进程 ready 后才向旧进程发 SIGTERM；旧进程排水（§4.4 ②）。
3. next 侧 env：`AGENT_RUNTIME=canary`、`AGENT_RUNTIME_PRODUCTIONS=<测试制作 id>`、`AGENT_RUNNER_URL=http://127.0.0.1:3102`，`pm2 reload production-manager --update-env`。
4. 网关保持在线：未列入灰度的会话照旧走网关；灰度会话即使开关回拨也继续走 runner。

## 重启不断会话（§4.4）是怎么成立的

- 每条消息落 `agent_session_entry`（步进持久化）；审批/提问的等待态在表里。
- `SIGTERM` → runner 拒绝新 run，等进行中的到自然停点；**等审批/提问的 run 立即"脱离"**（本地停手、不写 transcript、不发 aborted、不改 run 状态），由下一个进程按心跳过期接管：同一 toolCallId 复用同一张审批卡 / 同一个问题，不重问。
- `kill -9` / OOM → 下一个进程按中断点恢复：模型调用中 → 重发；只读工具中 → 重跑；写工具中 → 补「状态未知」交给模型（不盲重放）。
- 观看者（浏览器 SSE）只认 `(session, seq)` 游标，哪个进程在执行不可见；断线重连 `since=seq` 重放。

## 回滚

- 单会话：无（会话在 `agent_session` 就归 runner）。
- 全局：`AGENT_RUNTIME=gateway` + `pm2 reload production-manager --update-env`；新会话回网关，已有 runner 会话仍可读历史与继续对话（runner 进程需保留）。

## 冒烟清单（每次上线 runner 变更）

1. 发一条会调工具的消息，SSE 帧序 `ping → session → tool → tool-result → tool-end → delta… → final`。
2. 触发一次写工具：确认卡 → deny 带理由 → 模型收到理由。
3. 对话进行中 `pm2 reload agent-runner`：会话无感（不丢字、不重发、审批等待态存活）。
4. `kill -9` 一次 runner：下一进程 30s 内接管并续跑。
5. 50 轮长会话不爆窗（compaction 摘要可在 `agent_session_entry` 里看到 `type = 'compaction'`）。
