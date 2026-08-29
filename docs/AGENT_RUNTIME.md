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
| `BRAVE_API_KEY` | | 联网搜索（`web.search`，与网关时代同一个 Brave key）；不配则该工具回复"未配置"，`web.fetch` 不受影响 |
| `AGENT_WEB_FETCH_ALLOW_PRIVATE` | 未设 | `1` 时 `web.fetch` 放行内网地址——**只给测试**，线上绝不设 |
| `AGENT_TOOL_TIERS` | `off` | 关闭工具三层（全量工具），排障用 |
| `AGENT_TOOL_VEC_THRESHOLD` | `0.65` | 冷层向量召回阈值（用户消息 ↔ 工具例句余弦，text-embedding-v4 实测真命中 0.65–0.82、噪声 ≤0.60；族粒度整族入面，所以比单工具略紧）；词法阈值固定 0.72 |
| `AGENT_TOOL_RECALL_DEBUG` | 未设 | `1` 时每轮打印前 5 名工具的词法/向量分数，用于标定阈值 |
| `AGENT_DRAIN_TIMEOUT_MS` | 默认 600000 | 排水上限 |
| `AGENT_HEARTBEAT_MS` / `AGENT_ORPHAN_AFTER_MS` | 默认 5000 / 30000 | 租约心跳 / 判孤儿 |
| `AGENT_APPROVAL_TTL_MS` / `AGENT_QUESTION_TTL_MS` | 默认 10min / 15min | 审批 / 提问过期 |

### 冷层：召回 + `find_tools` 兜底

工具面 = 热层（按会话类型）∪ 温层（按页面）∪ 冷层召回 ∪ 本会话最近用过的工具（`used-tools.ts`：只看最近 3 个用户轮次、最多 6 个、最近优先——窗口外自然淘汰，避免一个 session 里东问西问把面越滚越大）。**召回的粒度是族**（`tool-catalog.ts` 的 `family`/`TOOL_FAMILIES`）：
族内任一工具过阈值 → 整族入面（每轮 ≤2 族），由模型在族内挑动作；族太大再拆 sub。冷层索引在 `lib/agent-runtime/tool-index.ts`：
每个工具的 `oneliner + examples`（`lib/mcp/tool-catalog.ts`）逐条嵌入，复用记忆检索的 embedding 供应商
（`EMBEDDING_PROVIDER`/`EMBEDDING_API_KEY`，向量缓存在 `agent_memory_embedding_cache`），未配置时退回纯词法。
没召回到时的兜底是常驻的 `clickin__find_tools`（搜索，不是目录——目录会随工具数线性吃 prompt）：
模型搜到名字后直接按名调用，harness 通过 `resolveDeferredTool`（vendor 补丁 #4）临时加载并在本会话后续轮次保持可见。
分层只决定可见性，权限与制作语境仍在工具内部判定。

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

## 服务器部署

CD（`.github/workflows/deploy.yml`）已经把 runner 纳入发布，**代码侧不需要人工动作**：

1. `npm run build:runner`：esbuild 把 `agent-runner/index.ts` + `lib/` + `vendor/` 打成单文件 `agent-runner.js` 放进 `.next/standalone/`，随 bundle 一起发；node_modules 用 standalone 追踪出来的那份（CD 会逐个核对 runner 的外部依赖都在，缺一个直接失败）。
2. DDL：`db/add-agent-runtime.sql` 由 CD 自动执行（记账 `shared/db-applied.txt`）。
3. pm2 进程定义收在仓库 [`deploy/ecosystem.config.js`](../deploy/ecosystem.config.js)（`agent-runner` + `production-manager`），每次发布覆盖到 `shared/ecosystem.config.js` 再 `pm2 reload … --update-env`。runner 用 **cluster 模式单实例**：新进程 `ready` 后才向旧进程发 SIGTERM（fork 模式的 reload 等于 restart，排水期间没人接请求）；`kill_timeout` ≥ 排水上限。

**唯一的人工动作：服务器 `shared/.env.local` 加两行**（合并前加好即可；CD reload 带 `--update-env`，发布时生效）：

```
AGENT_RUNTIME=runner
AGENT_RUNNER_URL=http://127.0.0.1:3102
```

其余 runner 需要的 env（`DEEPSEEK_API_KEY`、`EMBEDDING_*`、`PG*`、`AGENT_MEMORY_PATH`）与 next 共用同一份 `.env.local`，线上已有。
不做灰度（产品确认功能面本就小），直切；网关进程暂留，未列入 `agent_session` 的旧会话仍可读历史。

**上线后核对**：`pm2 ls` 里 `agent-runner` online；`curl -s --noproxy '*' http://127.0.0.1:3102/health` 返回 `{"ok":true,…}`；发一条会调工具的消息看 SSE 帧序（下方冒烟清单）。

## 写操作后自动刷新（mutation 行）

写工具在注册表里声明 `mutates`（`lib/agent-runtime/tools.ts`），成功执行后 runner 往 agent SSE 上发一行
`{ type: "mutation", scope, action, productionId, ids?, tool }`（紧跟 tool-end，同样落 `agent_event`，断线重连可补）。
前端 `AgentPopout` 收到后**只派发**（`lib/agent-mutations.ts`）：页面/组件用 `useAgentMutation({ scope, productionId }, handler)`
订阅，handler 自己决定刷新粒度——client 页面重拉那一个 API、server component 页面 `router.refresh()`、带 `ids` 的只在命中时动；
没人接才 `router.refresh()` 兜底。给新页面加自动刷新 = 写工具声明一句 `mutates` + 页面订阅一句，不碰 AgentPopout。
现有订阅者：`WikiShell`（scope `wiki` → 软刷新左树，300ms 合并）。

## 跨进程的东西

runner 是独立进程，**任何"进程内内存注册表"在它里面都是空的**。已知并已处理的一处：wiki 协作 SSE
（`lib/wiki-collab.ts`）——AI 写文档的 update/library 广播现在经 `wiki_collab_outbox` + `pg_notify('wiki_collab')`
送到持有浏览器连接的 next 进程（presence 帧不出站）。以后 runner 里的工具若要触达浏览器，一律走 DB 通知，
别再加内存事件总线。

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
