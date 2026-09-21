# AI Coding Agent 规约

本文件是仓库级硬规约的**索引**，对所有 AI coding agent（Claude Code 等）生效，`CLAUDE.md` 只做 `@AGENTS.md`。
规则本体与理由在 [docs/DEV_GUIDE.md](docs/DEV_GUIDE.md)（章节号在括号里）；改规约两边同批改，走 PR（#559）。
个人偏好 / 本机环境放 `CLAUDE.local.md` 或 `AGENTS.local.md`（gitignored），不要写进这里。

---

## 0. 通用

- 回复与代码注释用**简体中文**。
- 从 `main` 切分支前先 `git fetch`；分支前缀 `feat/ fix/ hotfix/ refactor/ chore/ test/ docs/`；PR 标题 Conventional Commits，正文关联 issue（§4）。
- `.github/workflows/` 不随功能 PR 改动（owner 单独审批）。
- 改了用户可感知行为：同 PR 改 `content/manual/**/*.md`（`updated` 改当天）+ 写 `content/changelog/unreleased/<pr>-<x>.md`（§12.5 §12.8）。
- 规约 / 棘轮挡住了合理的整理 → 同一 PR 改规约 + 改棘轮 + 改 DEV_GUIDE，PR 里说明为什么松；**不许**绕着规约做丑事，也不许因规约放弃整理（§1.3）。

## 1. 数据库与 migration（§6）

- 所有 schema 变更走 `db/migrations/<YYYYMMDDHHMMSS>_<snake_name>.sql`（`npm run db -- new <name>`），`-- migrate:up` / `-- migrate:down` 两段。
- **同一 PR 必须同步**：`db/schema.sql`（手写完整快照）+ `npm run db:check -- --update` 重生成的 `db/schema-fingerprint.txt`。CI 三方比对不等即红。
- `migrate:down`：只加列 / 加表 / 加索引写真 down；删列 / 删表 / 改类型 / 数据回填写 `DO $$ BEGIN RAISE EXCEPTION 'irreversible'; END $$;`。
- **expand / contract**：代码停止读写某列的版本不删列，删列放再下一个版本；N-1 代码必须能跑在 N schema 上。
- 破坏性 / 数据迁移必须附 `tests/migrations/<name>.migration.test.ts`（schema / integrity / invariance 三层）+ `<name>.snapshot.ts` hook；`global-setup` 按名自动发现，**不要改 global-setup**；数据回填的 hook 无条件造数（数据谓词在空库恒 false 会静默跳过）。
- 新表 PK 一律 `TEXT PRIMARY KEY` + 应用侧 short id（带随机尾）；不再用 `UUID DEFAULT gen_random_uuid()`（§13.1）。
- ❌ 修改 / 改名 / 删除已合并到 main 的 migration（CI 硬拦；修正另开一支）
- ❌ 把 invariance 测试改成无条件 skip / todo
- ❌ 在应用代码（`lib/` `app/`）执行 DDL；❌ 手改 `db/schema-fingerprint.txt`；❌ 在服务器手跑 SQL 改结构；❌ 往 `db/legacy/` 加文件
- 「已执行」的唯一真相是库里的 `schema_migrations` 表。

## 2. 权限门（§5）

- 旧原子权限（`hasPermission` / `Permission` union / `ROLE_TEMPLATE_PERMISSIONS` / `adminBypass`）**已退役**，别照旧文档写。
- 门语境一律 `hasEffectiveGrant` / `hasAnyEffectiveGrant`（自带 owner 旁路）或 `requireGrantGate`；裸 `hasGrant` 只在明确不给 owner 旁路时用并注释。create 类路由走 `canAccessNode` 六步链给三态。
- **`session.isAdmin` / `permCtx.isAdmin` 恒 false，是死字段**：新门不得依赖它；「平台级特权」先问。`memberPermissions === null` 判空放在 owner 旁路之后（owner 可不是成员）。
- **模版 ≠ 保证**：不因某键在模版里就跳过判定。**回填只放不收**：模版新增的键补给存量、裁剪的不回收；回填的是区间，键必须同时在 `PAGE_PERMISSION_SCOPES`。收紧裸门先问「存量项目谁还有资格路径」。
- 前端写面开关与判定端**逐键同源**（粗门只配开外壳）；门票键进 `PAGE_PERMISSION_SCOPES.base`、写面键进页面 scope；任何客户端改权限动作后 `router.refresh()`。
- 保留段 `grants / publication / assignees / imports` 与保留类型 `production / producer` 不被 `*` 覆盖。结构性可见（挂载让渡、引用边）永不物化 grant 行；语境不是权限；策略开关不得否决已有行。
- `ROLE_NAMES` 是默认模版不是白名单：在用的自定义角色不默认删。
- 自动授权写点（业务触发的 grant 发行 / 收回）新增或修改，PR 描述里单独列出。

## 3. 数据模型定式（§13.1）

- 版本体系已退役：只有 head，新设计不引入 version 维度，不引用「CoW 地基」约束新工作；悬空边 = 删除。
- node 树契约：边不投权限票、悬空即删、node id 寻址；业务实体不进树。
- 显示名 / 头像 / 联系方式一律 `LEFT JOIN user_profile`，禁增 `JOIN feishu_user` 取名（§8）。
- 权限与等级正交：权限管内容可见、等级管菜单有无，代码里分开传。`lib/account/plan.ts` 不可入客户端包。
- 成员查询必须选口径（active / `<> 'exited'`）；席位用 `occupiesSeat`。
- 页码单一口径 = 服务端估算 `page_map`；mention 存 block 锚点不存页码。
- 分享链接走 token 间接层，实体 id 不进 URL。

## 4. Next / React 边界（§13.3）

- **客户端组件只从零 node 依赖的模块 import**（`*-types.ts` / `*-score.ts`）；带 `node:fs` / `@/lib/pg` 的模块进客户端 bundle = 整站 500 含 `/login`，`tsc` 与 vitest 都不报。改完 `lib/` import 起 dev 请求 `/login` 看 `Module not found`。
- `"use client"` 组件 SSR 仍渲染一次：渲染期不读 `window`；删「初值 false、effect 置 true」的状态门前先问它是否在挡 SSR。
- React 监听器挂在 `document`：`stopPropagation` 拦不住自建 document 监听器（jsdom 里能拦 = 假绿），用 DOM 判据让行。
- 写时失效 client router cache 在本仓不可靠（#416 挂起），别再试廉价方案。
- 剪贴板按「Safari 只有 text/plain + text/html」设防。
- 主进程单实例是硬约束（协作 SSE 注册表在进程内存）。

## 5. 目录与棘轮（§1 §11.5）

- `lib/` `components/` `tests/` 同一套域名；新文件进域目录，`lib/` 根白名单、`components/` 根不放文件；域下最多一层组件族目录；不加 barrel `index.ts`。
- 行数棘轮撞线：如实上调记账值 + 注释说明；**不压行、不拆注释、不顺手删无关死代码凑数**。
- 搬 / 拆源文件前 `grep -rn "readFileSync(" tests/` 找静态棘轮；推送前跑**全量** `npm test`。
- 新查询函数写进 `lib/<域>/*-db.ts`；`lib/db.ts` 总仓已拆完删除（#486），不得重建。

## 6. 测试（§11）

- 工厂模式：每个文件 `makeProduction()` 等自建数据、`afterAll` `cleanupProduction(prodId).catch(() => {})`；❌ 依赖 seed 常量、❌ 对总行数写 count 断言、❌ 工厂里用 `importScriptToVersion`、❌ 在 `_support/helpers.ts` 加演出常量。
- `TEST_SEED` 确定性随机，CI 失败用打印的 seed 复现；固定 UUID 段用新段。
- 新 API route 必须有 401 / 非成员 403 / 只持单枚键 403 用例；不靠 `isAdmin: true` 过门。
- 模块级单例 / 注册表 / provider 注入必须另立静态断言盯注册点（单测自注册会 mock 掉接线）。
- 护栏用例必须验证它会红：可选表 JOIN 专测「缺行」分支；反证先 commit 再改、`git checkout --` 还原，不用 `git stash`。
- 源码不落字面 `\x00`；`git diff --stat` 见文本文件 `Bin` 立即排查。

## 7. UI（§13.4）

- 用 `components/ui/` 共享原语；上下文菜单各 kind 同一套项，不可用**灰掉给原因**不消失；带 panel 的东西必须对齐（量同排高度）。
- 原生元素换自定义组件：默认外观放 `@layer components` 不写内联 style；全库扫 CSS 里针对该元素的选择器；不写死 `width:100%`。
- 文档类界面 Notion 式：默认即编辑 + 自动保存，操作收左侧树栏。
- 手册页读者是导演 / 舞监：去技术化、只写现状、用读者的词、不训话、管理动作教操作者自己核实（§12.3）。

## 8. Git / PR 流程（§4）

- 叠 PR：前一个合并后**删分支**，否则下一层合进分支不进 main。
- tag 三种形态：里程碑 `v<M>.<m>.<p>`、日常 `-yymmdd`、hotfix `<被修 tag>-hot<n>`；日期版排在同号里程碑**之后**（§4「版本号」）。
- hotfix 从被修的 tag 切分支，不从 main；打 `<被修 tag>-hot<n>` 发 prod，changelog 只含本次修复。
- 已定位的 bug 直接 `gh issue create`（现象 / 根因 / 要做 / 定级）；孤儿组件、半成品、feature 方向先问。
- 报风险前先查可达性（后端门 → 前端调用点 → 组件是否被渲染 → setState 是否被调用过）。

## 9. AI 产品（docs/AGENT_RUNTIME.md「设计原则」）

- 站内 AI 是「能干的助理」不是「万能许愿机」：自治单位是批次、批次边界是合作点；skill 写升级协议不写案例大全；丢弃也是裁决，裁决权在人。
- 写工具先查权限（多钥匙域族内显式查询工具，不注入权限清单）；🔓 有资格未激活不可写；批量 = 数组参数一张卡。
- 无人值守写在注册表 `unattended` 声明，缺省 deny；写必进 `agent_mutation`；撤销永远是人的动作。
- 注入包裹标签必须在服务端真边界净化；可信脚手架内嵌用户数据即失可信。
- 加 / 改工具同批改注册表、`tool-catalog`、`agent-tool-labels` 三处；召回按族。
