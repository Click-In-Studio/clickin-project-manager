# vendor/openclaw

上游 OpenClaw monorepo 的核心包源码 vendor（#367 运行时自建，MIT，见同目录 LICENSE）。

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/openclaw/openclaw |
| 钉定版本 | tag `v2026.7.1-2`，commit `0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c` |
| 对应 npm | `@openclaw/ai@2026.7.1-2`（package.json 锁精确版本）——同一上游版本 |
| vendor 日期 | 2026-08-28 |

## 收录内容

- `packages/agent-core/src/`：agent 循环（`agent-loop.ts`）、harness（`harness/agent-harness.ts`）、会话树存储抽象（`harness/session/`）、压缩（`harness/compaction/`）。上游 `@openclaw/agent-core` 是 private 包未发布，只能 vendor。
- `packages/llm-core/src/`：模型/消息/事件类型与工具参数校验。上游 `@openclaw/llm-core` 未发布；agent-core 以相对路径 `../../llm-core/src/index.js` 引用它——**保持相同目录布局**就不用改任何 import。
- 排除全部 `*.test.ts` / `*.test-helpers.ts`。

## 纪律

1. **零本地改动为目标**；任何改动必须记在下方「本地补丁」表里，并以最小 diff 形式保留（便于升级时重放），仓库其他代码不得直接改 vendor 目录（lint 规则待加）。
2. 升级 = 有意识动作：拉新 tag → `rsync` 覆盖 → 重放本地补丁 → 跑 S1 出口判据（`tests/agent-runtime-*.test.ts`）→ 更新本表。**不追 beta**。
3. `@openclaw/ai` 与本目录必须来自同一上游版本（agent-core 通过 `@openclaw/ai/event-stream` 共享 `EventStream` 构造器身份，混版本会出现两个 EventStream 类）。

## 同步命令

```bash
git clone --filter=blob:none --sparse --depth 1 --branch <tag> https://github.com/openclaw/openclaw.git /tmp/openclaw-upstream
cd /tmp/openclaw-upstream && git sparse-checkout set packages/agent-core packages/llm-core
rsync -a --delete --exclude='*.test.ts' --exclude='*.test-helpers.ts' packages/agent-core/src/ <repo>/vendor/openclaw/packages/agent-core/src/
rsync -a --delete --exclude='*.test.ts' packages/llm-core/src/ <repo>/vendor/openclaw/packages/llm-core/src/
# 补丁 #3：去掉相对 import 的 .js 扩展名（Turbopack 不做 .js→.ts 映射；tsc bundler/vitest 两种写法都认）
find <repo>/vendor/openclaw/packages -name "*.ts" -exec sed -i '' -E 's#(from "\.{1,2}/[^"]+)\.js"#\1"#g; s#(import\("\.{1,2}/[^"]+)\.js"\)#\1")#g' {} +
```

## 本地补丁

| # | 文件 | 内容 | 原因 | 可上游？ |
|---|---|---|---|---|
| 1 | `packages/llm-core/src/utils/event-stream.ts` | 整文件改为从 `@openclaw/ai/event-stream` 重导出三个符号 | vendor 的 llm-core 与 npm 包内打包的 llm-core 各有一份 `EventStream` 类声明；`agent-loop.ts` 刻意取 npm 包的构造器共享身份，与本地声明类型冲突（private 成员分属两份声明）。统一为 npm 包那一份 | 否（上游是同一包，无此问题）——升级时**必须重放** |
| 2 | `packages/agent-core/src/harness/agent-harness.ts` | 新增 `continueTurn()` + `executeContinuation()`（`// ── 本地补丁 #2` 标记段），import 加 `runAgentLoopContinue` | 进程重启后恢复中途 run 需要"从 transcript 续跑而不追加用户消息"；上游 harness 只有 `prompt(text)`（必追加 user 消息），`runAgentLoopContinue` 只在 loop 层暴露、harness 的接线（hook/持久化/streamFn）全是 private，无法在外部复用 | **可上游**（纯新增方法，与 `executeTurn` 同构） |
| 4 | `packages/agent-core/src/harness/{types,agent-harness}.ts` | `AgentHarnessOptions.resolveDeferredTool` + 透传进 `createLoopConfig`；解析成功的工具同时登记进 `tools`/`activeToolNames` | agent-loop 本就支持"模型调了不在 context.tools 里的名字 → 问宿主要不要临时加载"，但 harness 没暴露这个钩子；且 loop 只改当前 context，harness 的 `prepareNextTurn` 每轮按 `activeToolNames` 重建工具面，不登记的话下一轮又不见了。冷层兜底（find_tools 搜到名字后直接调）靠它闭环 | **可上游**（透传 + 一处登记） |
| 3 | 全部 `*.ts` 的相对 import | 去掉 `.js` 扩展名（`./x.js` → `./x`），由同步命令里的 sed 自动完成 | Next/Turbopack 对相对路径不做 `.js → .ts` 映射，`next dev` 报 module-not-found；tsc（bundler）与 vitest 两种写法都认 | 否（上游是 NodeNext 风格）——机械变换，升级时随 sync 命令重放 |
