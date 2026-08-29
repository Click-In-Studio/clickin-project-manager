> **已作废（2026-08-29）**：本文是 OpenClaw 网关时代的 toolSearch 路线，网关与 `scripts/gateway-probe.ts` 均已退役；现行方案见 `docs/AGENT_RUNTIME.md`「冷层：召回 + find_tools 兜底」。留作历史。

# AI 工具面：Tool Search（3b 路线）运维手册

对应 issue #333（热/温/冷三层 → 发现面方案）。本文档覆盖：为什么、开关配置、
上线前必须跑的冒烟（含一条红线）、回滚、未来 3a 迁移。

## 背景与结论（详见 #333 探针报告与 v2 流程）

- 26 个 MCP 工具描述 ≈ 22k 字符每轮全量进 prompt，wiki 族占 56.7%。
- 服务器 gateway `2026.7.1-2` 的 `before_prompt_build` **不消费 `toolsAllow`**
  （7.2 才有），逐轮收窄工具面（3a 路线）需等网关升级。
- 官方 Tool Search 在 7.1-2 可用：开启后全部工具 schema 离开 prompt，落进
  目录，模型经 `tool_search` / `tool_describe` / `tool_call` 三件套取用。
  **收益 >80%**（常驻只剩三件套）。
- 官方 `tool_search` 是纯 ASCII 词法检索，**中文搜不到**——由本仓库的中文
  发现面补齐（`lib/mcp/tool-catalog.ts` 的 CJK bigram 召回，命中工具名随
  `<clickin-recall>` 注入，模型按名 `tool_describe` 直取，不依赖搜索）。

代码侧（本 PR）不依赖 Tool Search 也完整工作：召回提示里的「若当前工具列表
里看不到」措辞两态兼容。**开关是纯配置动作，可独立回滚。**

## 开启步骤（服务器）

1. 编辑 gateway 配置（openclaw 用户的默认 profile：`/home/openclaw/.openclaw/openclaw.json`）：

   ```jsonc
   {
     "tools": {
       "toolSearch": {
         "enabled": true,
         "mode": "tools"        // 显式写死。缺省是 "code"（沙箱代码模式），不是我们要的
         // searchDefaultLimit 缺省 8、maxSearchLimit 缺省 20，够用不必配
       }
     }
   }
   ```

2. 重启 gateway（`sudo -u openclaw` 按现行进程管理方式）。
3. 立即跑下方冒烟。红线不过 → 立即回滚（把 `enabled` 改回 `false` 重启）。

## 上线冒烟（P4，用现有 `scripts/gateway-probe.ts`，无需新代码）

### 🚨 红线（不过就回滚，没有商量余地）

**before_tool_call 在 `tool_call` 间接调用下必须看到真实工具名**
（`clickin__production-…`）。若 hook 看到的是 `tool_call`，clickin-memory 插件
的前缀判定失效 → 身份覆写（`_caller_user_id`）不注入 → 全部 clickin 工具
fail-closed 拒绝（"缺少调用者身份"）——整个 AI 工具面瘫痪。

静态证据（探针报告：目录条目经 `wrapCatalogTool` 携带 before_tool_call hook
上下文）指向"看到真实名"，但必须实测：

```bash
# gateway 机器上（bundle + scp 方式见 gateway-probe.ts 文件头）
node /tmp/gateway-probe.cjs --exercise "请调用 my.productions 工具（如果当前工具列表里没有它，用 tool_search 搜 productions，再用 tool_describe 和 tool_call 调用），把结果原样告诉我"
```

判据：最终回复包含真实的制作列表（或"未参与任何制作"），而不是
"拒绝：缺少调用者身份"。后者 = 红线爆了，回滚。

### 常规判据

1. **工具面确实收编**：`--exercise "逐字列出你当前可调用的全部工具名"` →
   应只见三件套（+内建），不见 26 个 clickin 工具。
2. **英文检索可命中**：`--exercise "用 tool_search 搜 wiki，把命中列表原样告诉我"` →
   命中 wiki 族。
3. **中文发现面兜底**：用真实 webchat（production 会话）发"帮我在文档库里
   搜一下排练相关的资料" → 回复能完成检索（召回把 `production.wiki_search`
   推进语境，模型 describe+call）。
4. **确认门仍在**：webchat 里让 AI 修改一篇文档 → 确认卡片照常弹出
   （tool_call 间接路径不得绕过审批门）。
5. **写面回归**：批准后修改真实生效、[[标题]] 引用被反解为 id 链接
   （查库 body 或 wiki_proposal 行确认）。

## 回滚

`tools.toolSearch.enabled: false`（或整段删掉）→ 重启 gateway。工具面回到
全量注入，本 PR 的 P1/P2 改动（方言三通道、校验真门、中文召回）不受影响、
继续生效。

## 未来：3a 迁移（网关升级 7.2 线之后）

7.2 的 `before_prompt_build` 消费 `toolsAllow`（对可见面与 Tool Search 目录
取**交集**——不在 allow 里的工具连搜都搜不到，见 #333 探针结论）。届时若要
迁 3a（热∪温∪召回命中 的逐轮 allow、关 toolSearch）：

- 关 `tools.toolSearch`，插件 `before_prompt_build` 返回 `toolsAllow`
  （7.1-2 会静默丢弃该字段，所以插件侧可以先发后生效）；
- 升级后必须实测：收窄真实生效 + 空数组语义（`.d.ts` 注释与预查结论矛盾，
  以实测为准）；
- 中文发现面（tool-catalog 召回）两条路线通用，不动。
