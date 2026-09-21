# 开发指南

给人读的完整版。AI coding agent 每次会话必读的硬规约在仓库根 [AGENTS.md](../AGENTS.md)——那是本文的索引，规则本体在这里；改规约两边同批改。

## 目录

1. [项目结构](#1-项目结构)
2. [技术栈](#2-技术栈)
3. [本地开发](#3-本地开发)
4. [开发工作流与分支规范](#4-开发工作流与分支规范)
5. [权限模型](#5-权限模型)
6. [数据库与 Migration](#6-数据库与-migration)
7. [文件存储（R2）](#7-文件存储r2)
8. [飞书集成与身份层](#8-飞书集成与身份层)
9. [AI Agent](#9-ai-agent)
10. [新增功能典型流程](#10-新增功能典型流程)
11. [单元测试](#11-单元测试)
12. [使用手册页与更新日志](#12-使用手册页与更新日志)
13. [设计定式与已知的坑](#13-设计定式与已知的坑)

---

## 1. 项目结构

### 1.1 目录树

```
/
├── app/                    # Next.js App Router 页面和 API
│   ├── api/                # API routes
│   │   ├── auth/           # 飞书 OAuth、登录、登出
│   │   ├── production/[id]/# 剧目相关 API（assets、events、cuelists 等）
│   │   ├── my/             # 当前用户相关（通知、权限）
│   │   └── internal/       # 内部 cron 接口（通知触发）
│   ├── production/[id]/    # 剧目子页面（剧本、构作、Cue、资产 等）
│   ├── my/                 # 个人页面（通知、权限、周 call、日 call）
│   ├── help/               # 公开帮助中心（§12）
│   └── login/              # 登录页
│
├── components/             # React 客户端组件——按域分目录（#482），根目录不放文件
│   ├── ui/                 # 通用原语：Badge PageHeader DropdownPicker OverflowSafeSelect TreePickerModal …
│   ├── shell/              # 应用外壳：AppShell、顶部菜单、搜索、水印
│   ├── admin/              # 管理后台各页面（Admin*Client）与其专属卡片
│   ├── ops/ script/ approval/ perm/ account/ notify/ agent/ help/   # 页面级容器与页面专属组件，按域
│   └── editor/ wiki/ assets/ import/ print/                         # 原有功能域目录
│
├── lib/                    # 服务端工具库——按域分目录（#482），根只留跨域基建
│   ├── pg.ts / r2.ts       # 连接池 / Cloudflare R2 presigned URL、multipart upload
│   ├── agent/              # AI：runtime/ tools/ memory/ chat/ + 注入安全、指令、配额、llm-chat
│   ├── script/             # 剧本：方言、标记、分页、template/（剧本版式模版）、打印 CSS
│   ├── editor/             # 文档编辑器原语：tiptap 扩展、块操作、粘贴、mention 类型
│   ├── wiki/  asset/  node/# 文档库 / 素材、元数据、头像 / 节点树（asset、wiki 壳节点一棵树）
│   ├── import/ doc-extract/# 剧本导入管线、文档抽取
│   ├── ops/                # 演出运营：事件、cue、任务、阶段、物料、财务
│   ├── approval/           # 审批：引擎、模版、路由、TTL、时间线
│   ├── perm/               # 权限：grant / 六步链 / 区间模版 / 角色 / 部门 / 成员 / 路由门
│   ├── production/         # 项目模版（templates/ + template-seeders/）与项目类型
│   ├── account/            # 账号：session、飞书身份、邀请、注册门、等级
│   ├── notify/  platform/  # 通知 / 外部平台适配（feishu/ email/）
│   ├── job/  help/         # 任务队列 / 帮助中心加载器、搜索、更新日志
│   └── tz.ts money.ts …    # 其余根文件 = 纯基建白名单（conventions.test.ts 钉死）
│
├── agent-runner/           # AI 运行时独立进程入口（主体在 lib/agent/runtime/，见 §9）
├── vendor/openclaw/        # vendor 的 agent-core / llm-core（本地补丁登记在 VENDOR.md）
├── openclaw-workspace/     # 站内 AI 的 base prompt 六件套（部署随 standalone 带上）
├── content/manual/  content/changelog/   # 使用手册页 / 更新日志碎片（§12）
├── db/                     # schema.sql + migrations/（dbmate）+ legacy/
├── tests/                  # 按域分目录，与 lib/ components/ 同一套域名（§1.2）
└── docs/                   # 项目文档
```

### 1.2 域目录归属表（lib/ · components/ · tests/ 同一套域名）

`tests/<域>/x.test.ts ↔ lib/<域>/x.ts` 能直接对上；`lib/` `components/` 比 `tests/` 多出几个更细的域，各自折叠进哪个 `tests/` 域以下表「测试归」列为准。归属不明时按「这个文件出 bug 先去看哪个模块」来定。

| 域 | `lib/` 收纳 | `components/` 收纳 | 测试归 |
|---|---|---|---|
| `agent/` | `runtime/` `tools/` `memory/` `chat/` 四个子目录 + 注入安全、指令、页面/UI 上下文、工具标签、`ai-quota` `llm-chat` | AgentPopout、AI 指令 / 用量卡片、`ai-target`、wiki 提案预览 | `agent/` |
| `script/` | `script-*`（方言、标记、分页、选区、焦点…）、`*-db`（`version-db` `script-view-db` `page-map-db` 及 #486 拆出的剧本读写）、`template/`（剧本版式模版）、`head-version` `print-css`、场次/角色字段权限 | ScriptEditor 及其对话框、场次/角色管理、戏剧构作与其表格视图组件 | `script/` |
| `editor/` | `editor-*`（块模型）、`tiptap-*`（扩展）、`line-merge` `table-ops` `remark-columns`、粘贴处理、`mention-types` | 块菜单 / 气泡菜单 / 表格工具、`SmartTextarea` | `wiki/`（编辑器原语的测试跟文档库走） |
| `wiki/` | 文档库 | 文档页、挂载面板、`WikiPrintPage`（文档打印，与剧本打印无关） | `wiki/` |
| `asset/` | 素材、元数据、头像（`avatar-*`） | `assets/`：上传、预览、挂载、分享 | `asset/` |
| `node/` `import/` `doc-extract/` | 节点树 / 导入管线 / 文档抽取 | 只有 `import/`：向导、列映射、`TagFormatOptionList` | `node/`→`wiki/`；`import/` `doc-extract/`→`script/` |
| `print/` | —（打印 CSS 在 `script/print-css`） | `ScriptPrint*`（剧本打印路由与渲染）、`template-render`、`use-fonts-settled` | `script/` |
| `ops/` | `event-*` `cue-*` `task-*` `phase-*` `finance-db` `material-*` `comment-db` `scene-duration` | 事件、cue、计划、任务、需求（req）、报告、周 call、工作区首页与项目首页 | `ops/` |
| `approval/` | `approval-*`：引擎、模版、路由、阶段、TTL、时间线 | AccessRequests 页与弹窗、ApprovalFlowDesigner | `ops/` |
| `perm/` | `permissions` `grant-*` `policy-*` `resource-*` `perm-center-db` `page-permission-scopes` `permission-*` `roles` `dept-db` `member-*` `admin-guard` `api-guard` | 权限激活弹窗 / 页面门、权限键选择器、成员选择器、我的权限页、通讯录、未授权页动作 | `perm/` |
| `production/` | `production-template` `production-types` `templates/`（各类型项目模版）`template-seeders/` | — | `ops/` |
| `account/` | `session` `db-feishu` `user-db` `email-auth-db` `invite-db` `registration-gate` `account-return` `plan` | 邀请接受页、我的项目、新建项目弹窗 | `account/` |
| `notify/` | `notify` `notification-prefs` `inbox-db` `card-token` `doc/`（通知文档渲染） | 通知页、通知中心、公告页 | `notify/` |
| `platform/` | 外部平台适配：`feishu/` `email/` 注册表、通知路由 | — | `notify/` `account/` |
| `job/` | 任务队列 | — | `platform/` |
| `mmp/` | MMP 多模态感知服务（自建 broker）的客户端、`ocr.structured` 封装、GPU 用量记账（#453 / #618）；只在服务端用 | — | `agent/` |
| `help/` | 手册加载器、frontmatter、搜索索引 / 打分、bug 报告、更新日志 | 帮助中心顶栏、左树、正文渲染、搜索、BugReportModal | `help/` |
| `admin/` | — | 13 个 `Admin*Client` + AdminActivationGate、Danger/Migration 段、BulkInvite / TransferOwner / ProductionPlan 卡片、InviteModal | `perm/` `ops/` |
| `ui/` | — | 通用原语：Badge ChevronIcon DropdownPicker DurationInput Markdown MarkdownEditor OverflowSafeSelect PageHeader PageSkeleton SmartText TreePickerModal AdminModal（通用弹窗，名字是历史）`my-pages.module.css` | `platform/` |
| `shell/` | — | 应用外壳：AppShell（子件与纯函数在 `app-shell/` 族目录）ProductionTopMenu SearchBar ManualSaveNotice WatermarkOverlay `watermark-tile` | `platform/` |
| 根 | 纯基建白名单：`pg` `r2` `server-cache` `tz` `money` `duration` `lex-order` `z-index` `base-path` `server-url` `request-json` `sse-keepalive` `nav-pending` `search-db` | 不放文件 | `platform/` |

### 1.3 归属与命名规则

- **`components/` 三分**：通用原语进 `ui/`、应用外壳进 `shell/`、后台页面进 `admin/`，其余页面级 `*Client.tsx` 与页面专属组件按域走。页面容器**留在 `components/` 不 colocate 到 `app/`**——`app/` 路由树已深达十层，且页面容器有复用。归属按消费者定：只被一个域的页面用的进那个域（如 `TableViewSelector` 只服务戏剧构作 → `script/`）；跨域共用才进 `ui/`。`.module.css` 跟随消费者。
- **文件名两种形态**：默认导出组件的文件 PascalCase，hook / context / util / 共享样式 kebab-case（`use-fonts-settled.ts` `ai-target.tsx` `my-pages.module.css`）。
- **组件族目录**（#487）：域下允许**一层**族目录，收巨石组件拆出来的子件 / hook / 纯函数——`components/shell/app-shell/{ProjectSwitcher,NavItem,…}.tsx` + `toolbar-stage.ts` `route.ts`。族目录名 kebab-case = 主组件名，主组件自己留在域目录不进族；族内不再套目录。族目录只为一个主组件服务，跨组件共用的东西按消费者归域或进 `ui/`。族内文件有行数上限：PascalCase 组件 ≤ 800、kebab 模块 ≤ 400（`conventions.test.ts` 的 `FAMILY_FILE_CEILING`），整块搬出来就超标的按搬出时的行数记账只降不升（`FAMILY_FILE_GRANDFATHERED`）。
- **`lib/` 根目录的文件清单由 `conventions.test.ts` 白名单钉死**：新文件一律进域目录，真正的跨域基建才加白名单（同 PR 更新上表）。不加 barrel `index.ts`（`platform/email` `platform/feishu` `script/template` 三个既有的保留）——全仓 import 走深路径，barrel 只会引入循环依赖风险。
- 「template」一词在仓库里指五种东西，各归其域：剧本版式模版 `script/template/`、项目模版 `production/templates/`、权限模版 `perm/grant-template`、审批模版 `approval/approval-flow-template*`、cue 模版 `ops/cue-template-db`。
- **行数棘轮是为可读性与解耦服务的**（`MONOLITH_LINE_CEILING` / `DB_FILE_GRANDFATHERED` / `FAMILY_FILE_*`）：撞线时先判断增长是否合理（修 bug、必要字段 = 合理），合理就如实上调记账值并在注释里写明哪个 PR 加了几行；**不得**为了满足数字把新代码压成一行、拆注释、或顺手删无关死代码凑数。死代码清理另开 PR。规约挡住了合理的整理（如拆巨石需要族目录）就同一 PR 改规约 + 改棘轮 + 改本文，并在 PR 里说明为什么松。

---

## 2. 技术栈

| 层 | 选型 |
|----|------|
| 框架 | Next.js 16 App Router（TypeScript） |
| 样式 | Tailwind CSS v4 |
| 富文本 | TipTap（剧本编辑器、文档编辑器） |
| 数据库 | PostgreSQL 16 + pgvector（`pg` 原生驱动，无 ORM；migration 用 dbmate） |
| 文件存储 | Cloudflare R2（S3 兼容，AWS Signature V4 手写） |
| 身份验证 | 飞书 OAuth 2.0 / 邮箱验证码，HMAC 签名 Cookie session |
| 音频波形 | WaveSurfer.js v7（动态 import） |
| AI | 自建运行时（`lib/agent/runtime/` + `agent-runner/`），provider OpenAI-compatible（DeepSeek） |

### Next.js 说明

本项目使用 Next.js **16**，部分 API 与旧版本有差异：

- Route Handler 的 `params` 是 `Promise`，需要 `await ctx.params`
- `cookies()` 和 `headers()` 是异步函数
- `"use client"` 组件在 SSR 阶段仍会在服务端渲染一次（见 §13.3）

在编写路由或中间件前请先阅读 `node_modules/next/dist/docs/` 中的相关说明。

---

## 3. 本地开发

### 环境变量

复制 `.env.local.example` 为 `.env.local`，按注释填写：

```
# ── 核心（必填）──────────────────────────────────────────────────────────────
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=xxxxxxxx
# FEISHU_REDIRECT_URI 已不再需要，redirect_uri 由服务器从请求 Host 头动态构造
# 本地开发时飞书应用需在「安全设置 → 重定向 URL」中添加：
#   http://127.0.0.1:3000/api/oath-callback

SESSION_SECRET=any-random-string        # 生产环境必须设置；本地开发可留空（有警告）

# ── 数据库（主库）── macOS 本地开发通常无需设置（使用系统用户 peer auth）─────
# 若本地 PostgreSQL 要求密码，或在 Linux/Docker 环境，则取消注释并填写：
# PGHOST=localhost
# PGDATABASE=script_editor
# PGUSER=your-os-username
# PGPASSWORD=your-password
#
# 连接池四道闸（#459，缺省值见 lib/pg.ts，一般不用动；0 = 关闭该闸）：
# PG_POOL_MAX=20                 # 单进程池上限。线上三个进程各一池，和不能超 max_connections
# PG_STATEMENT_TIMEOUT_MS=15000  # 单条语句（含等锁）封顶
# PG_IDLE_IN_TX_TIMEOUT_MS=30000 # 事务开着不动的连接封顶
# PG_CONNECTION_TIMEOUT_MS=10000 # 池满时取连接的等待封顶

# ── 文件上传（使用资产/文件功能时必填）──────────────────────────────────────
R2_ACCOUNT_ID=xxxxxxxx
R2_ACCESS_KEY_ID=xxxxxxxx
R2_SECRET_ACCESS_KEY=xxxxxxxx
R2_BUCKET=click-in-test                 # 本地建议用独立测试 bucket

# ── LLM（记忆蒸馏 lib/agent/llm-chat.ts；站内 AI 对话见 docs/AGENT_RUNTIME.md）──────
LLM_PROVIDER=openai                     # openai（默认）或 deepseek
OPENAI_API_KEY=sk-xxxxxxxx
# OPENAI_MODEL=gpt-4o-mini             # 可选，默认 gpt-4o-mini
# DEEPSEEK_API_KEY=sk-xxxxxxxx         # 使用 DeepSeek 时设置
# DEEPSEEK_MODEL=deepseek-chat

INTERNAL_NOTIFY_SECRET=any-local-secret # 定时通知 cron 鉴权 Bearer token

# ── Agent 记忆检索（可选；不配则记忆检索走纯关键词模式）─────────────────────
# EMBEDDING_PROVIDER=dashscope          # dashscope（有 key 时的默认）| none（纯关键词）| fake（测试）
# EMBEDDING_API_KEY=sk-xxxxxxxx         # DashScope API key（百炼控制台获取）
# EMBEDDING_MODEL=text-embedding-v4     # 默认；换模型=索引身份变化，须跑 memory-index-backfill --rebuild
# EMBEDDING_BASE_URL=…                  # 默认 DashScope compatible-mode，一般不用改
```

### 数据库初始化

```bash
# 主库（macOS Homebrew PostgreSQL — 当前 OS 用户拥有该库）
createdb script_editor
npm run db -- up          # 空库：从 baseline 跑到最新（dbmate，见 §6）

# 已经用旧方式（psql -f db/schema.sql）建过库的：只记账，不重跑
npm run db -- mark-baseline
```

> Linux / Docker 环境需切换到 postgres 超级用户：`sudo -u postgres psql ...`

### 启动开发服务器

```bash
npm install
npm run dev
```

访问 `http://127.0.0.1:3000`（注意：飞书 OAuth 的回调 URL 必须是 `127.0.0.1`，不是 `localhost`）。

`npm run seed:local-demo` 灌一个虚拟项目 `demo-misty-harbor`（手册截图、本地摸产品用）。在仓库里跑 `npm run build` 会覆盖 `.next/` 的 dev 缓存 → `next dev` 起不来、tsc 报 `RouteContext`；`rm -rf .next` 重启 dev 即可。

### R2 CORS（本地调试上传/预览）

在 Cloudflare Dashboard 给测试 bucket `click-in-test` 配置 CORS：

```json
[{
  "AllowedOrigins": ["http://127.0.0.1:3000"],
  "AllowedMethods": ["GET", "PUT"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": [],
  "MaxAgeSeconds": 3600
}]
```

### 剧本字体（自托管）

剧本的三个面全部自托管，`@font-face` 在 **生成文件** `app/fonts.css` 里，字体片在 `public/fonts/<face>/`：

| CSS 家族 | 用途 | 字体 |
|---|---|---|
| `SourceHanSerif` | 台词正文 | 思源宋体 CN Medium / Bold |
| `LXGWWenKai` | 舞台指示（含对白里的行内舞台指示） | 霞鹜文楷 Regular |
| `ZhuqueFangsong` | 歌词 | 朱雀仿宋 Regular |

为什么必须自托管：行内舞台指示内嵌在对白块里，字体不同 → 拉丁 / 标点进宽不同 → 换行点不同 → **分页不同**。系统楷体三个平台三种字宽，Linux 上干脆没有。

- 改字体（换版本、加面、调切片区间）只改 `scripts/fonts/build-fonts.py`，然后跑 `python3 scripts/fonts/build-fonts.py`（需要 `pip install fonttools brotli`）——它会按钉死的 URL + sha256 下载源文件到 `scripts/fonts/src/`（gitignored），重切并重写 `app/fonts.css` 与 `public/fonts/manifest.json`。**不要手改 fonts.css**。
- 字体栈的次序是分页一致性的一部分：首选自托管面 → 缺字落到同样自托管的 `SourceHanSerif` → 最后才是系统字体。`tests/script/fonts-self-hosted.test.ts` 守着这条与切片覆盖。
- 切片按**字频分层**不按码位（#594）：`cjk-common`（GB2312 一级 3755 字）/ `cjk-rare`（二级 3008 字）各一片，其余 CJK 按 0x400 码位一片。两层的 `unicode-range` 故意写整段 `U+4E00-9FFF` 而不是几千段精确区间，靠 CSS Fonts 的「同 family 后声明的面优先、没字形落到前一条」——所以 fonts.css 里**块片在前、rare 次之、common 最后**，顺序是语义，护栏测试盯着。一页中文台词只拉 common 一片（思源 Medium 约 700 KB），二级字多拉 rare，更罕见的字才拉对应块片。
- 弱网：`/fonts/*` 一年 `immutable`（url 带内容 sha 的 `?v=`），某片加载失败由 `components/print/font-retry.ts` 按同描述符重建 FontFace 重试三次（CSS 声明的面没有重试 API）。
- 跨平台一致性：`scripts/print-consistency/check.ts` 在无头 Chromium 里打开一份夹具剧本的打印路由，与 `golden.json`（Mac 生成）比对页数与每页边界；CI 在 Linux 上跑。三份 golden：`golden.json`（居中角色名）、`golden-compact.json`（左栏角色名，`FIXTURE_TEXT_LAYOUT=compact GOLDEN_PATH=…`）、`golden-broadway.json`（百老汇模版，`FIXTURE_TEMPLATE_ID=broadway-musical@1 GOLDEN_PATH=…`）。改了分页 / 打印 / 字体相关文件而 golden 该变时，本地起 dev server 后 `BASE_URL=http://localhost:3000 npx tsx scripts/print-consistency/check.ts --update` 重新生成并提交。这两份 golden 也是**排版模版引擎的验收线**：legacy 模版的输出必须与它们一致（`docs/script-template-engine.md` §4）。
- 打印就绪信号 `body[data-print-ready="1"]` 只在**字体全部就位之后的那次分页测量**完成时才出现（`components/print/use-fonts-settled.ts`）。无头出片等这个属性，不要 sleep。

---

## 4. 开发工作流与分支规范

### 分支命名

| 类型 | 前缀 | 示例 |
|------|------|------|
| 新功能 | `feat/` | `feat/scene-export` |
| Bug 修复 | `fix/` | `fix/auth-session-expiry` |
| 线上热修 | `hotfix/` | `hotfix/591-forwarded-proto` |
| 重构 / 整理 | `refactor/` `chore/` | `refactor/internal-user-id` |
| 测试 | `test/` | `test/factory-based-tests` |
| 文档 | `docs/` | `docs/update-dev-guide` |

### 分支保护

`main` 分支受双层保护（Branch Protection + Ruleset "Main Protection"）：

- **禁止直接 push**：所有变更必须通过 Pull Request
- **禁止 force push**（需要时：先临时关闭两层保护，完成后立即恢复）
- **禁止删除** `main` 分支

### Issue 与 PR 工作流

1. **开 Issue** → 在 GitHub Issues 描述问题或需求，打 label，关联 milestone。开之前 `gh issue list --search` 一下，孤儿组件 / 半成品往往已经有 issue 或是挂账项。
2. **创建分支** → 从 `main` 拉取（先 `git fetch`），按命名规范命名
3. **开 Pull Request** → 关联对应 Issue；PR 标题用 [Conventional Commits](https://www.conventionalcommits.org/) 格式（`feat:`、`fix:`、`docs:` 等）
4. **CI 自动触发**：
   - `lint-and-typecheck`：TypeScript 类型检查 + ESLint
   - `unit-test`：Vitest 单元测试（含 migration 测试与 `npm run db:check`）
   - `print-consistency`：跨平台分页 golden 比对
5. **自动请求 Review**：CODEOWNERS（`.github/CODEOWNERS`）配置 `* @kevin-wang-2 @Click-In-Studio/reviewer`，PR 创建后自动 request review；AI review 每 PR 出 findings，逐条判定真伪再修，误报回复不改
6. **需要 1 个 approving review** 才能合并（必须来自 code owner）
7. **合并方式**：merge / squash / rebase 均允许；日常开发推荐 squash 保持 `main` 历史干净

### 版本号（#612）

tag 名 = `content/changelog/` 版本目录名，形态由 `lib/help/changelog.ts` 的 `CHANGELOG_VERSION_RE` 硬校验（目录名不合形态整站 `loadChangelog()` 抛错）。三种：

| 形态 | 什么时候打 | 例 |
|---|---|---|
| `v<M>.<m>.<p>` | **里程碑**。`M` 阶段（内测 / 公开 / …，几年一动）；`m` 正式版（一组功能闭环，会上大家认可进入新阶段）；`p` 功能（一个跨多周的大功能**用户能完整用上了**，版本本身还没闭环） | `v0.1.2` |
| `v<M>.<m>.<p>-yymmdd` | **日常发版**（每周三、周日会后）。三段沿用上一个里程碑，加当天日期 | `v0.1.2-260924` |
| `<被修版本完整号>-hot<n>` | **hotfix**。线上炸了从被修的 tag 切分支修，序号从 1 起；里程碑本身炸了没有日期段 | `v0.1.2-260924-hot1` / `v0.2.0-hot1` |

- 顺序：里程碑三段 → 日期 → hot 序号，`v0.1.1 < v0.1.1-260921 < v0.1.1-260921-hot1 < v0.1.1-260924 < v0.1.2 < v0.2.0`。**日期版在同号里程碑之后**——日常版是里程碑的后续，不是它的预览，和 semver 预发布语义相反；`git tag --sort=v:refname` 会排反，以 `compareVersions` 为准。
- 任意一段跳，日期段清零：大功能落地的那次周三 / 周日发版直接打 `v0.1.2`，不打 `v0.1.1-yymmdd`。
- `p` 是里程碑不是补丁：它没有日期段、可以被 hotfix，与 semver patch 含义不同。bump `p` 的判据是「用户能完整用上」，不是「开始做了」或「合了一半」——半成品继续走日期版。
- 同一天不打两个日期版：会后发的版炸了就是 hotfix。
- 两段号（`v0.2`）不再接受；已有的 `v0.1.0` `v0.1.1` 不动。

### 发版与 hotfix（#558）

- push `main` → 自动发 **dev**（`app-dev.clickinmusical.com`）；push tag `v*` → 自动发 **prod**（`app.clickinmusical.com`）。发 prod = `npm run changelog:release -- <tag>` → 编辑 commit → `git tag <tag> && git push origin <tag>`。
- **hotfix 从被修的 tag 切分支，不从 main**（main 领先 tag 一大截，从 main 发等于把未发的全推上去）：`git switch -c hotfix/<n> v0.1.2-260924` → 改 → 在该 commit 打 `v0.1.2-260924-hot1` 推 tag → 分支再补 `content/changelog/<tag>/`（只含本次修复）→ PR 回 main。
- 详见 [DEPLOY.md](./DEPLOY.md)。

### 叠 PR（stacked PR）

同一文件连续拆 PR 时把后一个的 base 指向前一个的分支是对的，但前一个合并后**分支必须删掉**——GitHub 只在 base 分支被删除时才把后续 PR 的 base 自动切回 main；分支留着，后一个 PR 就会合进那条已经合过的分支，代码不在 main 上（#501→#504 事故）。合并后 `git ls-remote --heads origin | grep <前缀>` 核一遍。

### 特别注意

- CI 通过与否不强制阻断合并（无 required status checks），但 CI 红灯时不应合并
- 改了用户可感知行为的 PR 必须同步手册页与更新日志碎片（§12.5、§12.8），PR 模板里有勾选项
- **`.github/workflows/` 文件（CI/CD pipeline）属于基础设施，不在普通功能开发范围内。** CODEOWNERS 对该目录配置了独立规则，任何改动必须由仓库 owner（`@kevin-wang-2`）审批，不得作为日常 feature PR 的一部分附带修改。

---

## 5. 权限模型

> 旧的原子权限系统（`Permission` union / `hasPermission` / `ROLE_TEMPLATE_PERMISSIONS` / `adminBypass`）已于 2026-08 全部退役（`lib/perm/permission-migration-ledger.ts` 的 RETIRED 清单）。看到这些名字的代码或文档都是历史，不要照着写。

### 5.1 一棵树、一张行表、四个动词

每个剧目的资源组成一棵三层树 `type/<id>/<sub>`（sub 是静态词汇，不嵌实例 id），权限是这棵树上的**原子行**：

```
production_member_grant:  (user, production, resource_type, resource_id, resource_sub, verb)
verb ∈ { view, create, edit, delete }        # 闭集，永不扩充
```

- **权限非线性**：行与行之间无蕴含（持有 edit 不意味着持有 view）。判定端零蕴含、零特判、零代码模板。
- **通配**：`resource_id = '*'` 表示该类型全部实例；`sub = '*'` 表示全部子面。制作人模版发的是 `node:*/*@*`（永久全集，新增权限键零 migration）。
- **保留段**（`RESERVED_SUBS`：`grants` `publication` `assignees` `imports`）**与保留类型**（`RESERVED_TYPES`：`production` `producer`）**不被 `*` 通配覆盖**，必须显式指名——它们是治理面与批量破坏性操作，不能随「全部」一起发出去。
- 常用语义：`<type>/*/meta@view` = 目录可见（列表权）；`<type>/<id>/<sub>@view` = 看某个面的内容；`grants@edit` = 管理该资源的授权（旧 manage）；`publication@*` = 发布 / 提前看草稿。

### 5.2 区间三表与六步链（canAccessNode）

行是「已激活」的权限；「有资格但未激活」记在**区间**里，键形 `node:<type>/<id>[/<sub>]@<verb>`：

| 表 | 来源 |
|---|---|
| `production_role_permission` | 角色区间，建项目时由项目模版（`lib/production/templates/*.ts`）按项目类型 seed |
| `production_dept_permission` | 部门区间，树向下继承（伞语义） |
| `production_member_permission` | 个人 allow / deny |

`canAccessNode(actor, productionId, type, id, sub, verb)`（`lib/perm/grant-template.ts`）按六步链判定：**grant 行 → 个人 deny → 部门区间 → 角色区间 → 个人 allow → 申请流**，返回三态：

```typescript
{ allowed: true }
{ allowed: false, reason: "needs_self_confirm", source }   // 有区间，去激活面一键自确认落行
{ allowed: false, reason: "needs_approval" }                // 无区间，走审批申请
{ allowed: false, reason: "no_entry" }                      // SENSITIVE 无区间 / ROOT 非 owner：连入口都没有
```

治理键（SENSITIVE / ROOT，`isSensitiveNode` / `isRootNode` 手写清单）永不自确认：区间行只是审批入口资格。

### 5.3 旁路：owner 是，isAdmin 不是

`PermissionContext`（`getProductionPermissionContext(userId, session.isAdmin, productionId)` 返回的 `permCtx`）里：

- `isOwner`：项目主，代码级旁路，所有门都过。**owner 可以不是成员**——`memberPermissions === null` 的 fails-closed 判空必须放在 owner 旁路**之后**。
- `isAdmin`：**恒为 false 的死字段**。唯一数据源 `feishu_user.is_super_admin` 早已写死 false 且每次登录覆盖回 false，`/api/dev/make-admin` 线上 403。依赖它的门 = 无人能过的孤门（PR #281 事故：线上没人能建项目）。`isAdmin || isOwner` 成对写法是安全的（等价于 isOwner），不必清理，但**别新写**；需要「平台级特权」先问——目前没有任何机制能产生这种身份，要重建走用户等级（§13.1）。
- 拆掉一条 isAdmin 门之前先问「这条路径上还有哪些查询在靠 admin 全量分支活着」（PR #282：owner 建完项目从自己列表里消失）。

### 5.4 路由怎么写门

```typescript
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";

const session = getSession(req.cookies);
if (!session) return Response.json({ error: "未登录" }, { status: 401 });
const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });  // 写路由
const actor = toActor(session, access.permCtx);

// 能力门放在所有字段校验之前：授权优先于格式
if (!await hasEffectiveGrant(actor, productionId, "wiki", "*", "*", "create"))
  return Response.json({ error: "权限不足" }, { status: 403 });
```

- **门语境一律用 `hasEffectiveGrant` / `hasAnyEffectiveGrant`**（自带 owner 旁路）。裸 `hasGrant` / `hasAnyGrant` / `listGrantedResourceIds` 不含任何旁路，只在明确「能力票不该给 owner 旁路」的场景使用并写注释。 `app/` `components/` `lib/` 全域硬禁（`tests/perm/bare-grant-ratchet.test.ts`，#604）：判定核白名单（`lib/perm/*`、各域 `perm.ts` 等，见测试文件）之外出现一处即红，`import { hasGrant as x }` 改名也红。白名单里的文件每个函数顶端自己写旁路；真要「不给 owner 旁路」把判定下沉到白名单文件并注释，加白名单要在 PR 里说明。
- 样板收敛：`requireGrantGate(req, productionId, [[type, sub, verb], …], { blockArchived })`（`lib/perm/api-guard.ts`）= session → ctx → OR 链 → 归档 一次搞定。
- 需要三态（告诉用户「去激活」还是「去申请」）用 `canAccessNode`；批量判定用 `canAccessNodesBatch`。create 类路由走 `canAccessNode` 六步链而非裸 `hasGrant`，否则持区间未激活的人只拿到无指向的「权限不足」。
- 全项目级通道（SSE 流等）的粗门用 `hasAnyGrant(type, subs, verb)`。
- 结构性可见（挂载让渡、引用边）**永不物化 grant 行**，在判定函数里按上下文算（`lib/node/host-visibility.ts` 等）。

### 5.5 页面门与激活面

- 页面的 view 门跑在 redirect 之前；「有区间未激活」的人靠 **激活面**把区间落成行：`PAGE_PERMISSION_SCOPES`（`lib/perm/page-permission-scopes.ts`）按页面列出可自确认的键，`PageActivationGate` / `usePendingPermissions` 弹窗一键确认。
  - **门票键必须进 `base`**（各域 `meta@view` / `blocks@view`）——进不去页面就见不到该页的弹窗。
  - **写面键必须登记在它所在页面的 scope 里**，否则持区间者在那页永远激活不出行（2026-08-17 事故：四个域只删不填，全库 33 人打不开剧本页；`tests/perm/activation-scope-coverage.test.ts` 是棘轮）。
  - 只放判定端真实消费的键。
- **任何客户端改权限的动作（激活面、授权面）之后必须 `router.refresh()`**——写面开关是服务端组件渲染时查库算出来的，不刷新就是「一键激活 → 弹窗消失 → 页面仍然只读」。
- **前端写面开关与判定端逐键同源**：判定端有几条路由、各查什么键，前端就得有几个 prop；粗门（`any`）只能用来决定「值不值得显示编辑态外壳」，永远不能直接开某个具体动作（PR #359 一次审出四处：一枚 `character/*@edit` 开三个入口）。折行成门的逻辑抽成纯函数，用「只持单枚键」的用例上棘轮——这类 bug 在全集持钥人身上永远不显形。

### 5.6 模版、回填与角色

- 项目模版（`lib/production/templates/{theatre,music,film,…}.ts` + `shared.ts`）在建项目时 seed 区间，**运行时零读取**。
- **模版 ≠ 保证**：不得因某键在模版基线里就跳过实际判定——模版会按项目类型分化、项目内配置随时可改（严格剧组会把「全员」行撤掉只授 POC）。写文档说「模版默认」而非「全员默认」；测试要覆盖「模版行被撤掉」的场景。
- **回填只放不收**：模版与存量项目对不上时，模版新增的键回填给存量同名角色（`INSERT … ON CONFLICT DO NOTHING`，按角色名 scoped、跳过 `is_deprecated`、持通配键的角色整个跳过、按项目类型 scope），模版裁剪的键一律保留不动。回填的是**区间**不是 grant 行，成员仍经激活面自确认——所以回填的键必须同时在 `PAGE_PERMISSION_SCOPES` 里。
- **收紧裸门时先问「存量项目谁还有资格路径」**：裸门语义 = 全员，无旧键可映射；只映射旧键 = 存量项目零人可用（PR #404：十个项目零人可传素材）。
- `ROLE_NAMES` 是**默认模版不是白名单**：项目可以有自定义角色；清理时在用的自定义角色不默认删，列为决策点问。制作人角色三重保护（不可删、不可改名、权限集合修改 = owner 操作）。
- 业务触发的 grant 发行 / 收回写点（创建者行集、指派触发、POC 任期等）是**自动授权定式**，新增或修改必须在 PR 描述里单独列出。

### 5.7 新增功能的权限检查清单

1. 资源类型 / 子面 / 动词怎么落到树上？新 sub 若是治理面或批量破坏性操作，进 `RESERVED_SUBS`。
2. 路由用 `hasEffectiveGrant` 族或 `requireGrantGate`；写路由挡归档。
3. 哪些角色默认有资格？→ 改 `lib/production/templates/*.ts`（各类型分别看）；存量项目要回填的写 migration（只放不收）。
4. 门票键进 `PAGE_PERMISSION_SCOPES.base`，写面键进页面 scope。
5. 前端开关逐键同源；改权限的动作后 `router.refresh()`。
6. 测试：无 cookie → 401、非成员 → 403、只持单枚键 → 对应入口开 / 其它 403（§11.6）。

---

## 6. 数据库与 Migration

### 6.1 数据库

只有一个库 `script_editor`（`PG*` 环境变量）。OpenClaw 时代的 `click_in_agent` 库与 `agent_user` 角色已退役（#367 / #603）：代码不读 `AGENT_PG*`，主库上的授权由 migration 回收，老机器上残留的库与角色按 DEPLOY.md「退役 Agent 库」一次性清掉。

### 6.2 Schema 文件

- **`db/schema.sql`** — 主库的完整规范 schema：手写、可读、幂等。它是「全部 migration 跑完之后」的快照，也是新库的快速建库脚本。
- **`db/migrations/`** — dbmate 迁移目录，一支一个文件 `<YYYYMMDDHHMMSS>_<name>.sql`。库怎么从上一版走到这一版，只看这里。第一支 `20260919000000_baseline.sql` 是接管时 schema.sql 的冻结拷贝。
- **`db/schema-fingerprint.txt`** — 由 `db/fingerprint.sql` 从 schema.sql 建出的空库算出的结构指纹（列 / 约束 / 索引 / 枚举 / 自有函数 / 触发器，一行一对象）。CI 与 CD 都拿它比对，**生成不手改**。
- **`db/bootstrap-roles.sql`** — 新环境一次性引导：应用角色 `script_editor` 与默认权限。schema.sql 从不含 GRANT。
- **`db/legacy/`** — dbmate 接管前的 144 支历史迁移，只读，见其 README。不要往里加文件，不要引用它写新东西。

### 6.3 Schema 演进（dbmate）

三个真相源，各管一件事：

| 文件 | 回答什么 | 谁写 |
|---|---|---|
| `schema_migrations` 表（库里） | 这个库应用过哪些 migration | dbmate |
| `db/migrations/*.sql` | 库怎么从上一版走到这一版 | 人 |
| `db/schema.sql` | 最终形状是什么 | 人 |

「人写两份会不一致」由 `npm run db:check` 机器兜底：空库跑 migrations、空库跑 schema.sql、提交的指纹三方逐行比，不等即 CI 红；CD 发布后再拿线上库指纹比一次，不等即部署红（#561）。

**加一支 migration：**

```bash
npm run db -- new add_something        # 生成 db/migrations/20260919120000_add_something.sql
```

```sql
-- migrate:up
ALTER TABLE production ADD COLUMN IF NOT EXISTS new_col TEXT;

-- migrate:down
ALTER TABLE production DROP COLUMN IF EXISTS new_col;
```

然后：

1. 同样的 DDL 写进 `db/schema.sql` 对应位置（保持它是完整快照）。
2. `npm run db:check -- --update` 重生成 `db/schema-fingerprint.txt`，三个文件一起提交。
3. 本地 `npm run db -- up` 应用；`npm run db -- status` 看状态；`npm run db -- down` 回滚最近一支。
4. 破坏性 / 数据迁移另需 `tests/migrations/<name>.migration.test.ts` 三层测试与 `<name>.snapshot.ts` hook（§6.6）。

`<name>` 用 snake_case 动词短语（`add_x` / `drop_x` / `backfill_x` / `rename_x`）：是否破坏性看内容，不看文件名。新表 PK 一律 `TEXT PRIMARY KEY` + 应用侧 short id（§13.1）。

**`-- migrate:down` 的规则**

- 只加列 / 加表 / 加索引：写真正的 down（`DROP … IF EXISTS`）。
- 删列 / 删表 / 改类型 / 数据回填：down 写 `DO $$ BEGIN RAISE EXCEPTION 'irreversible'; END $$;`——不要假装能逆。这类变更的回退靠 CD 发布前自动做的 `shared/backups/pre_migration_*.pgdump`。
- 一支文件默认整段一个事务；`CREATE INDEX CONCURRENTLY` 之类不能进事务的，段头写 `-- migrate:up transaction:false`。

**expand / contract（回退能力的真正来源）**

- 代码停止读写某列的那个版本**不删列**；删列放到再下一个版本。
- 因此任何时刻 N-1 版本的代码都能跑在 N 版本的 schema 上，`rollback.sh` 切软链就是完整回退，不需要 reverse migration。
- 改列类型、改 NOT NULL 同理：先加新列双写，再切读，最后删旧列，三个版本。

**CD 自动执行**：发布时 `dbmate up` 应用全部 pending（单事务、失败整体回滚并中止部署），随后核对线上指纹。无需任何手动操作。

> ⚠️ **严禁在应用代码（`lib/`、`app/`）中执行任何 DDL（`ALTER TABLE`、`CREATE TABLE`、`DROP`、`TRUNCATE` 等）。**
> 应用 DB 用户（`script_editor`）以 `GRANT` 方式获得 DML 权限，**不是表的 owner**，执行 DDL 会报 `must be owner of table`（42501），请求 500。所有 schema 变更必须通过 `db/migrations/` 由 CD 以 `postgres` 用户身份执行。`conventions.test.ts` 静态扫描守着这条（§11.5 ①）。也不要在服务器上手跑 SQL 改结构——下一次发布的指纹校验会把手改的差异报成红。

### 6.4 Migration 文件的修改规则

Migration 文件一经合并到 `main`，**不得修改、改名或删除**，CI 硬拦（`Forbid touching merged migrations`）。dbmate 以文件名里的版本号记账，改内容不会触发重新执行，改动会静默丢失。

```
❌ 错误：直接修改 db/migrations/20260919120000_add_something.sql
✅ 正确：npm run db -- new fix_something，写补丁 SQL
```

### 6.5 时区约定

- 数据库所有时间字段使用 `TIMESTAMPTZ`，存储 UTC。
- 面向用户展示时转为 UTC+8（`Asia/Shanghai`），代码全部显式指定时区，不依赖机器 TZ（prod 机是 UTC、dev 机是 Asia/Shanghai）。
- 工具函数在 `lib/tz.ts`。

### 6.6 破坏性 Migration 的三层测试

删除列、重命名列、改类型、数据回填等统称破坏性 migration（区别于只新增列/表的增量 migration）。它们**不可 git-revert 数据**，所以要在 CI 里证明数据转换是对的。每支破坏性 migration 附带：

```
tests/migrations/<name>.migration.test.ts   # 三层测试
tests/migrations/<name>.snapshot.ts         # hook：迁移前造数并快照
```

`<name>` 与 `db/migrations/<版本>_<name>.sql` 的 `<name>` 完全一致，`tests/_support/global-setup.ts` 按名字自动发现，**不需要改 global-setup**。

| 层级 | describe 名称 | 作用 | 危险度 |
|------|-------------|------|--------|
| **Schema 验证** | `schema verification` | 列类型、NOT NULL、列是否存在/消失 | 低 |
| **完整性验证** | `integrity verification` | FK 无孤儿行、UNIQUE 无重复、JSONB 无残留旧 key | 中——能发现引用断裂，不能发现错误映射 |
| **Invariance 验证** | `invariance verification` | 逐行对比迁移前后的映射，确认 ID 没有错误对应 | **高——唯一能捕获静默数据腐化的层** |

**Invariance 模式**：hook 在迁移**之前**用裸 SQL 在旧结构上造数并把原始 FK 值写进快照；测试在迁移**之后**通过新 FK 反查，验证映射回来的旧 ID 与快照一致。

```typescript
// tests/migrations/drop_task_milestone.snapshot.ts
import type { MigrationHook } from "../_support/global-setup";

export const SNAPSHOT_PATH = path.join(os.tmpdir(), "drop-task-milestone-snapshot.json");
export type Snapshot = { prodId: string; edges: { taskId: string; milestoneId: string }[] };
export const createPreMigrationData: MigrationHook<Snapshot>["createPreMigrationData"] =
  async ({ pool, testUser }) => { /* 在旧结构上裸 SQL 造数，返回快照 */ };
export const cleanup: MigrationHook<Snapshot>["cleanup"] =
  async (pool, snap) => { await pool.query("DELETE FROM production WHERE id = $1", [snap.prodId]); };
```

```typescript
// 快照必须在模块顶层同步 readFileSync（skipIf 在收集期求值）
it.skipIf(!snapshot)("someTable: every user_id resolves to original open_id", async () => {
  const expected = new Map(snapshot!.rows.someTable.map((r) => [r.key, r.openId]));
  const { rows } = await getPool().query("SELECT id, user_id FROM some_table");
  const mismatches: string[] = [];
  for (const row of rows) {
    const resolved = await resolveUserIdToOpenId(row.user_id);
    if (resolved !== expected.get(row.id)) mismatches.push(`id=${row.id}`);
  }
  expect(mismatches).toEqual([]);
});
```

`it.skipIf(!snapshot)` 是正确模式：有快照时强制跑（CI migration path），没有快照时自动跳过（本地已迁移库）。**不要把 invariance 测试改为无条件 skip 或 todo。**

**hook 的已知陷阱**

- `global-setup.ts` 里不要 `faker.seed()`（`tests/_support/setup.ts` 已按 `TEST_SEED` 为每个测试文件 re-seed，两处同 seed ⇒ hook 造的第一个 production id 与测试层 `makeProduction()` 撞 PK）；多个 hook 也不能各自用同一 seed。
- 快照工厂的 INSERT 列名要对着 `db/schema.sql` 核（`version.name` 不是 `label`；`poc_extra_permissions` 在 `production_dept_member` 上）。
- 裸 SQL 造 production 必须随手补 `script_view` 主本 + `master_view_id`（script-view 迁移有全局 integrity 断言）；asset uploader 须有 person 归属行。
- **数据回填迁移不能用数据谓词做 gate**：CI 库无数据行，「存在未迁移形态的行」在空库恒 false ⇒ 工厂不建、快照不落、invariance 静默跳过，恰好在最需要验证的 PR 里。数据回填类（scoped + 幂等）在 hook 里**无条件**造数，并把「重放第二跑插入行数」记进快照、断言为 0 当幂等证明。
- 正文批量换 id 用裸 `replace` 会因前缀关系咬断长 id（`cueAB` 是 `cueABX` 的前缀）：按尾随分隔符锚定 `regexp_replace(body, prefix || old || '([)?#&])', prefix || new || '\1', 'g')`，分隔符集合取自解析侧那条正则；工厂数据里**必造一对前缀关系的证人 id** 单开一条 invariance 断言。
- `TEST_USER` 会被 hook 加成成员，不能用于「非成员」断言；要非成员用一个从不出现在任何工厂的固定 UUID。
- `resilience.test.ts` / `api-race.test.ts` 故意触发 PK 冲突，DB 日志里的 ERROR 是预期行为；排查 CI 以 vitest 的 `FAIL` 为准。

**CI 路径**：`unit-test` job 检测 PR 是否新增 `db/migrations/*.sql`（`git diff origin/$GITHUB_BASE_REF --diff-filter=A`）。有 → 用 base 分支的 migrations 建旧结构库 → `npm run db:check` → `npm test`（global-setup 发现 pending → 逐支找 `<name>.snapshot.ts` 造数、快照 → `dbmate up` → invariance 强制验证）。无 → 空库 `npm run db -- up` → `db:check` → `npm test`。已合并 migration 被改 / 改名 / 删 → 直接红。

**本地**：库已应用全部 migration 时没有 pending，hook 不跑、invariance 自动跳过，这是预期行为。想本地复现：`npm run db -- down` 回到上一版（前提是该支 down 可逆）再 `npm test`；或 `createdb scratch && git show origin/main:db/schema.sql | psql -d scratch && PGDATABASE=scratch npm test` 模拟 CI。`db/legacy/` 时代的迁移测试仍在 `tests/migrations/`，它们的 invariance 层永远 skip，只剩 schema / integrity 层当回归护栏。

### 6.7 Migration PR 检查清单

- [ ] `db/migrations/<版本>_<name>.sql`：`migrate:up` 完整；`migrate:down` 真逆或 `RAISE EXCEPTION`
- [ ] `db/schema.sql` 更新为迁移后的最终状态
- [ ] `db/schema-fingerprint.txt` 由 `npm run db:check -- --update` 重新生成
- [ ] 破坏性 / 数据迁移：`tests/migrations/<name>.migration.test.ts`（三层）+ `<name>.snapshot.ts`
- [ ] expand / contract：删列 / 删表不与停用它的代码同一版本上线
- [ ] `npm test` 本地通过

---

## 7. 文件存储（R2）

### Key 命名规范

```
assets/{assetFileId}/{safeFileName}   # 资产文件
thumbnails/{assetFileId}.webp         # 缩略图
avatars/…/avatar-<ts>                 # 头像（版本在 key 里，换头像即换 key）
```

函数在 `lib/r2.ts`：`assetR2Key()`、`thumbnailR2Key()`。

### Presign 流程

R2 不经过服务器中转，客户端直接 PUT：

1. 客户端调 `/api/.../presign` → 服务端生成 presigned PUT URL 返回
2. 客户端用 XHR 直接 PUT 到 R2
3. 上传完成后，客户端 POST `/api/.../assets` 注册元数据到数据库

大文件（>50MB）走 multipart upload，分片并行上传；弱网降级走 `relay-part` 路由（60MB 帽 + 并发槽 2）。Multipart 完成时由服务端调 `listMultipartParts()` 从 R2 直接获取各分片 ETag，不依赖客户端传值（浏览器无法读取 CORS 跨域响应的 ETag header）。缩略图 / 元数据分析不在上传路径同步做：缩略图走后台任务队列（`lib/job/`，`JOB_WORKER=1` 的 heavy-worker 进程消费），元数据走懒轨（首次请求时分析写回 `asset_file.metadata`）。

### AWS Signature V4 注意事项

`lib/r2.ts` 手写 AWS Sig V4 实现：
- `sortedParams()` 按**字节序**排序（`X`(0x58) < `r`(0x72)），不用 `localeCompare`。
- presigned GET 加 `response-content-disposition=inline` 和 `response-content-type` 参数可让浏览器内嵌展示而非下载；`cacheWindow`（签名时间窗对齐）和 `cacheControl`（透传 response-cache-control）用于让浏览器缓存——R2 响应默认无缓存头。

---

## 8. 飞书集成与身份层

### OAuth 登录流程

```
用户点击登录
  → /api/auth/login  → 根据请求 Host 构造 redirect_uri → 重定向到飞书授权页
  → 飞书回调 /api/oath-callback  → 换 token → 注册门 → 写 session cookie → 重定向首页
```

redirect_uri 由 `requestOrigin()`（`lib/server-url.ts`）从 `Host` / `x-forwarded-host` 构造，**非回环 host 一律 https**（Next 对缺失的 `x-forwarded-proto` 会自己补 `http`，不能信这个头；#591）。支持 `app.*` 和 `backstage.*` 各自独立回调。飞书客户端内嵌自动登录（`tt.requestAuthCode`）已删除，飞书内也是普通 OAuth。

注册与登录分开：登录意图不设门；注册意图（新身份）经 `lib/account/registration-gate.ts` 按 `(platformId, platformUserId)` 判定（邀请码 / 登记邮箱 / 定向邀请 / 邀请链接四选一，`REGISTRATION_INVITE_ONLY=1` 时生效）。凭据经 httpOnly 的 `oauth_ctx` cookie 跨越往返，不编进 `state`。

Session 存为 HMAC 签名的 Cookie，不需要服务端 session store。内容：`{ userId, name, avatarUrl, isAdmin }`（`userId` 为 `app_user.id`；`isAdmin` 是死字段，见 §5.3）。用户等级不进 session（7 天 cookie 会陈旧），低频实时查库。

### 身份层

`app_user` 是身份锚、`user_profile` 是资料源（飞书登录同事务同步）、`user_platform_identity` 记各平台身份（飞书 / 邮箱）；`feishu_user` 只是飞书的平台同步层。**取显示名 / 头像 / 联系方式一律 `LEFT JOIN user_profile`**（勿 INNER——工厂测试用户可能无 profile 行，`COALESCE` 兜底），新代码禁增 `JOIN feishu_user` 取名（PR #234 清过一遍）。合法保留的 `feishu_user` 用途：open_id（通知）、OAuth upsert / 绑定、账户合并、同步值回落。

### 联合导入的数据替换约定

联合导入的确认请求是一次原子替换：确认前不得写入 Tag、构作、剧本、角色关系或 Cue；确认后，目标版本的构作、剧本内容和全部 Cue 以本次导入结果为准。聚合角色成员关系同样是全量替换，旧成员关系被删除是当前的预期行为。所有可预先验证的映射和引用必须在删除旧数据前验证，事务内任一步骤失败时必须整体回滚。

### Bot（飞书群消息）

已退役（2026-08，随 #367 自建运行时上线）。飞书侧仍在用的只有 OAuth 登录与通知推送（`lib/platform/feishu/`）。

---

## 9. AI Agent

站内 AI 对话由自建运行时承担（`lib/agent/runtime/` + 独立进程 `agent-runner/`），怎么跑 / 怎么切 / 怎么回滚 / 工具注册表 / 无人值守写 / 审计 / 定时任务 / 用量限流全部见 [AGENT_RUNTIME.md](./AGENT_RUNTIME.md)，**设计新工具或新 skill 前先读那篇的「设计原则」一节**。

老运行时保留下来的两个通用模块：`lib/agent/llm-chat.ts`（OpenAI-compatible 对话调用，记忆蒸馏在用）与 `lib/agent/memory/embedding.ts`（向量嵌入，记忆检索与工具索引在用）。`docs/TOOL_SURFACE.md` 是网关时代的历史文档。

---

## 10. 新增功能典型流程

以"给剧目新增一个子页面"为例：

### 步骤一：数据库（如需新表/字段）

1. `npm run db -- new add_xxx`，写 `db/migrations/<时间戳>_add_xxx.sql`，同步写进 `db/schema.sql`，`npm run db:check -- --update`（§6.3）。新表 `TEXT PRIMARY KEY` + short id。
2. 在 `lib/<域>/xxx-db.ts` 里加查询函数（不要往 `lib/db.ts` 里加，它正在拆）。

### 步骤二：API

在 `app/api/production/[id]/your-feature/route.ts` 创建 Route Handler：

```typescript
import { type NextRequest } from "next/server";
import { requireGrantGate } from "@/lib/perm/api-guard";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;          // Next.js 16: params 是 Promise
  const gate = await requireGrantGate(req, id, [["your_type", "meta", "view"]]);
  if (gate.deny) return gate.deny;
  const { session, access } = gate;         // access.permCtx / access.isArchived 可用
  // ...业务逻辑
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = await requireGrantGate(req, id, [["your_type", "*", "create"]], { blockArchived: true });
  if (gate.deny) return gate.deny;
  // ...
}
```

需要三态或按实例判定的门手写（§5.4）。请求体解析用 `lib/request-json.ts`；权限门放在字段校验之前。

### 步骤三：页面

在 `app/production/[id]/your-feature/page.tsx` 创建 Server Component：做服务端 auth 检查、算出该页的写面开关（逐键），然后渲染客户端组件。客户端逻辑放在 `components/<域>/YourFeatureClient.tsx`（`"use client"`），**只从纯模块 import 常量 / 类型 / 纯函数**——带 `node:fs` / `@/lib/pg` 的模块进了客户端 bundle 整站 500（§13.3）。

### 步骤四：导航与激活面

在 `components/shell/app-shell/nav-config.ts` 加入口（手册覆盖棘轮会要求同 PR 补手册页，§12.4）；页面门票键进 `PAGE_PERMISSION_SCOPES.base`、写面键进页面 scope（§5.5）。`fetch()`、`<a href>` 等非 `<Link>` 场景用 `${BASE_PATH}/...`（`BASE_PATH` 现在恒为空串，保留只为兼容）。

### 步骤五：手册、更新日志、测试

- 同 PR 改 `content/manual/**/*.md` + `updated`（§12.5），写 `content/changelog/unreleased/<pr>-<x>.md` 碎片（§12.8）。
- 按 §11.6 覆盖约定补测试；改到 `lib/` 的 import 后起 dev server 请求一下 `/login` 看日志有没有 `Module not found`。

### 步骤六：部署

合并到 `main` 后 CD 自动发 dev；打 tag 发 prod。详见 [DEPLOY.md](./DEPLOY.md)。

---

## 11. 单元测试

### 11.1 定位与目标

本项目的测试套件以**预防为目的**，不是事后审计。每条测试都是对一条不变量的断言——随着代码演化，只要这条不变量被破坏，CI 就立即报告。

被保护的不变量按优先级分两级：

**Top Priority — 数据完整性**：不论怎么操作、误操作、并发，数据不能乱——不能出现重复条目、孤儿条目，并发写入不能破坏状态一致性（advisory lock、last-write-wins 均需验证），级联删除必须全量触发。数据一旦损坏很难在不停服的情况下修复，且往往静默破坏后续功能。

**P1 — 数据安全性**：没有权限的用户不能读取或修改他人数据——跨 production 的读/写被拒；未登录、session 篡改/过期均 401；权限不足 403 且不能通过猜测 ID 绕过；只持单枚键的人只能开对应的那个入口。

测试运行器为 **Vitest**，直接连接测试数据库（CI 中为临时创建的空库，测试数据全部由工厂函数在运行时生成）。

```bash
npm test                             # 跑全部测试（vitest run，约 5 分钟）
npm test -- tests/perm               # 只跑一个域（推送前仍要跑全量，见 §11.5 ⑤）
npm test -- --reporter=verbose       # 显示每条测试名称
TEST_SEED=1234567890 npm test        # 用固定 seed 复现 CI 失败
```

### 11.2 目录结构

`tests/` 按业务域分目录，域名与 `lib/` `components/` 同一套（归属见 §1.2），migration 测试单独成域。域目录只有一层，不再嵌套：

```
tests/
├── _support/          # 支撑件，不含测试
│   ├── global-setup.ts    # DB 生命周期（setup / teardown）+ TEST_SEED 初始化 + migration hook 循环
│   ├── setup.ts           # 每个 worker 的 faker 种子初始化
│   ├── factories.ts       # 工厂函数：makeProduction / makeScene / makeBlocks 等
│   ├── helpers.ts         # 常量：TEST_USER
│   ├── fixtures/          # 参照样本（如 legacy-script-page.ts）
│   └── mocks/             # 模块替身（vitest.config.ts 的 alias 指过来）
├── migrations/        # *.migration.test.ts + 配套 *.snapshot.ts hook（§6.6）
├── agent/ wiki/ script/ asset/ perm/ ops/ account/ notify/ help/ platform/
```

域内的相对 import 一律走 `../_support/`：

```typescript
import { makeProduction, cleanupProduction } from "../_support/factories";
import { TEST_USER } from "../_support/helpers";
```

`TEST_USER`（`"test-sys-user"`）在 `global-setup.ts` 的 `setup()` 阶段插入，`teardown()` 时删除。所有测试文件共用这一账号，**不要在单个测试文件里重复创建或删除它**；不要在 `helpers.ts` 里新增演出常量——需要演出请用 `makeProduction()`。测试里固定 UUID 段（`0000…/0001…/0002…/0007…`）已被占用，新测试文件用新段，否则并行跑时 `user_profile` upsert 互相改名。

### 11.3 DB 层测试规范

DB 层测试直接调用 `lib/<域>/*-db.ts` 中的函数，不经过 HTTP 层。

#### 工厂模式（必须遵守）

每个测试文件在 `beforeAll` 中创建自己需要的数据，在 `afterAll` 中清理，不依赖任何预存的演出数据：

```typescript
import { makeProduction, makeScene, makeCharacter, cleanupProduction } from "../_support/factories";

let prodId: string;
let versionId: string;
let sceneId: string;

beforeAll(async () => {
  ({ prodId, versionId } = await makeProduction());
  sceneId = await makeScene(prodId, versionId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});   // .catch 防前序失败时级联报错
});
```

| 函数 | 说明 |
|------|------|
| `makeProduction()` | 创建演出 + 初始 version，返回 `{ prodId, versionId }`（默认 free 档；测档位门内功能用 `setProductionTier(prodId, 'pro')`） |
| `cleanupProduction(prodId)` | 先删 `scene_version` / `character_version`（无 CASCADE FK），再删演出（其余 CASCADE） |
| `makeScene(prodId, versionId)` | 累加式添加场景，返回 sceneId |
| `makeCharacter(prodId, versionId)` | 累加式添加角色，返回 charId |
| `makeBlocks(prodId, versionId, count)` | 累加式插入 dialogue 块，返回 `string[]` |
| `makeLegacyVersion(...)` | 裸 SQL 模拟多版本共享态（生产代码已无多版本入口） |
| `shortId()` | 生成 `t` 前缀的确定性随机 7 位 ID，用于 hardcoded 资源 ID |

**禁止**：在工厂函数或测试中使用 `importScriptToVersion`——它会清除该 version 的所有 blocks。

#### 确定性随机

`faker` 通过 `process.env.TEST_SEED` 初始化，`global-setup.ts` 在每次 `npm test` 时随机生成一个 seed 并打印（`Test seed: 2847291034  (reproduce: TEST_SEED=2847291034 npm test)`），CI 失败后用它本地精确复现。

#### 测试断言

只断言自己创建的数据，**不对数据库总行数作任何假设**：

```typescript
// ✅ 只检查工厂创建的那条记录
expect(scenes.some((s) => s.id === sceneId)).toBe(true);
// ❌ 断言总行数（依赖 DB 状态，脆弱）
expect(scenes.length).toBeGreaterThanOrEqual(50);
```

### 11.4 API 层测试规范

API 层测试**直接 import 并调用 route handler 函数**，不需要启动 HTTP 服务器。

```typescript
import { createSession, SESSION_COOKIE } from "@/lib/account/session";

function sessionFor(userId: string) {
  return createSession({ userId, name: "测试员", avatarUrl: null, isAdmin: false });
}
function req(url: string, opts: { session?: string; method?: string; body?: string } = {}) {
  const headers = new Headers();
  if (opts.session) headers.set("cookie", `${SESSION_COOKIE}=${opts.session}`);
  return new NextRequest(`http://localhost${url}`, { method: opts.method, body: opts.body, headers });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(params: Record<string, string>): any {
  return { params: Promise.resolve(params) };
}

const res = await listCueListsHandler(req(`/api/production/${prodId}/cuelists`, { session: sessionFor(TEST_USER) }), ctx({ id: prodId }));
```

**权限**：`isAdmin: true` 的 session 在生产不存在（§5.3），测试也不要靠它过门。要过门就给用户发对应的行——`addProductionMember` + 直接 INSERT `production_member_grant`（或走 `writeXxxGrants` 行集函数）；要测「只持单枚键」就只发那一枚。owner 旁路用工厂演出的 owner 账号测。非成员 → `getProductionPermissionContext` 返回 `null` → 403。

### 11.5 开发规约自动化测试（conventions.test.ts）

`tests/platform/conventions.test.ts` 包含以下自动化规约检查，CI 和本地 `npm test` 都会跑。

#### ① 运行时 DDL 静态扫描

扫描 `lib/` 和 `app/api/` 中所有 `.ts` 文件，检测 SQL 执行上下文（template literal 内部或 `.query(` 调用行）中出现的 DDL 关键词。**豁免**：违规行末尾加 `// ddl-check-ignore`，仅在有充分理由时使用。

#### ② 运行时 Migration 幂等性

**当前没有任何运行时 migration 函数——这是刻意的。** 最后一支 `ensureScriptMarkerMigration` 已连同整套基础设施删除，原因是运行时迁移路径天生带四个系统性风险：DB 出错时无退避的重试死循环、void promise 让调用方观察不到真实成败、进程重启丢失内存态导致全量重跑、以及迁移检查闸死整条写路径。存量数据一律走 `db/migrations/` 的数据迁移。**若确有不得已要新增**：必须在本节补上对应的幂等性测试（空 version 立即返回 ready + 连调两次行数不变），并同时给出上述四个风险各自的规避方案，否则 PR 不应被合并。

#### ③ Schema 三方一致性（`npm run db:check`）

见 §6.3。它在临时库上跑，不看你本地开发库的状态。失败时会分两段说清是哪一侧不一致。

#### ④ 目录形态与行数棘轮

- `tests/`：根目录无测试文件、域目录下不套层、`_support/` 不放测试、migration 三件套只住 `migrations/`。只钉形态不钉名单，新开域目录不用改测试。
- `components/`：根目录无文件、域目录下最多一层组件族目录、文件名为 PascalCase 或 kebab-case 两种形态之一（§1.3）。
- `lib/`：根目录文件 ⊆ 基建白名单，且白名单无幽灵条目。
- 行数：`MONOLITH_LINE_CEILING`（五个巨石组件只降不升，上限不得比实际高 100 行以上）、族内文件上限、`DB_FILE_GRANDFATHERED`（各 `*-db.ts` ≤ 1000 行）；`lib/db.ts` 已于 #486 拆完删除，棘轮钉它不再出现。撞线的处理见 §1.3 末条。
- `openclaw-workspace/` 五件套必须全部 tracked（gitignore guard）。

#### ⑤ 静态棘轮跨域读原文

不少棘轮按路径 `readFileSync` 读源码原文断言接线（`tests/wiki/wiki-node-id-guard.test.ts` 读 `app-shell/route.ts`、`tests/agent/ai-target-context.test.tsx` 读 `AppShell.tsx`、activation-scope-coverage、tool-catalog 同源……）。**拆分 / 搬移源文件前先 `grep -rn "readFileSync(" tests/` 找出读它的棘轮**，改指新文件并追加「原文件必须从新位置接线」的断言；推送前跑**全量** `npm test`，只跑改动所在域会假绿（PR #488 事故）。

### 11.6 覆盖范围约定

| 优先级 | 类型 | 覆盖要求 |
|--------|------|---------|
| **Top** | 新增会修改数据的 DB 函数 | **必须**加重复 ID 抛错、并发只有一个成功、删除后不可读的完整性验证 |
| **Top** | 级联关系变更（外键、ON DELETE） | **必须**在 `resilience.test.ts` 中验证级联删除全量触发、无孤儿行 |
| **Top** | 并发写入路径（advisory lock、唯一约束） | **必须**在 `api-race.test.ts` 中验证并发结果的一致性 |
| **P1** | 新增 API route | **必须**加 auth guard（无 cookie → 401）和 authorization（非成员 → 403、只持单枚键 → 其它动作 403） |
| **P1** | 新增跨 production 的读写操作 | **必须**在 `security.test.ts` 中加"错误 productionId → null / no-op"验证 |
| — | 新增读操作 DB 函数 | 建议加 happy path + 不存在时返回 null 的测试 |
| — | Schema 变更 | **必须**同步 `db/schema.sql` + 指纹（§6.3）；破坏性的附三层测试（§6.6） |
| — | 模块级单例 / 全局注册表 / provider 注入 | **必须**另立静态断言盯注册点（单测自己注册依赖会把接线层 mock 掉，`tsc` 也管不到运行时注册；PR #474 事故） |
| — | client 组件的 SSR 安全 | 改登录页等 client component 后用 `renderToString` 在 node 环境跑一遍（§13.3） |
| — | 流式路由（SSE）、R2、飞书 | 暂不强制（依赖外部服务，需独立策略） |

> **合并阻断条件**：`npm test` 全部通过，且上表标注"**必须**"的覆盖项不能留白。

**护栏用例必须验证它确实会红**，否则等于没测：
- 工厂会补齐线上并不存在的前提行，「缺行」分支永远测不到。凡是读路径 JOIN 了「后加的可选配置表」，专门写一条显式 DELETE 掉那行的用例，并先连生产库数一下 `count(*) FILTER (WHERE x.id IS NULL)`（#263：`escalateExpiredApprovals` INNER JOIN 后加的表，线上 8 个演出全缺行，超时升级从未生效过）。可选配置缺行的语义应是「按列默认值」（LEFT JOIN + COALESCE），不是功能静默失效。
- 修复点在管线上游时，先找出下游还有哪几层会掩盖它（JS 侧 `dedup()` 替 SQL 兜住了 `DISTINCT ON`），把规模推到那些层兜不住的地方。反证要红得恰好是目标那条，全红多半是反证本身写坏了。
- 反证「撤掉门/字段看测试变红」时：**先 commit 再反证**，改完 `git checkout -- <file>` 还原。不要用 `git stash`（改动已 commit 时 stash 不创建条目、紧接着的 pop 会弹出别人的旧 stash 污染工作区）；对未提交的改动 `git checkout --` 是整文件抹除。

---

## 12. 使用手册页与更新日志

面向用户的使用手册是站内公开的帮助中心 **`/help`**（#523 / #531）：不登录可看、可外发给潜在客户。
内容不进数据库，就是仓库里的 markdown——**功能 PR 顺手改手册页，部署即更新**，没有第二真相源。

### 12.1 目录即信息架构

```
content/manual/
├── _TEMPLATE.md               # 作者模板（复制它开新页）
├── _home.md                   # 首页配置：quickstart / popular 两个 slug 列表
├── start/                     # 一级：按用户旅程（start / creation / production / admin / account / ai）
│   ├── _index.md              #   title / order / summary
│   └── login/                 # 二级：逐字对齐 nav-config 的菜单名（「注册与登录」「Cue」「成员与部门」…）
│       ├── _index.md
│       └── register-and-login.md   # 文章；slug = start/login/register-and-login → /help/start/login/register-and-login
└── …
public/manual/<一级>/*.png     # 截图；正文里写 ![说明](/manual/start/login.png)
```

三层封顶：二级目录下不允许再建目录（加载器直接报错）。下划线开头的文件不是页面。

### 12.2 frontmatter 契约

```yaml
---
title: 创建 Cue 表                # 必填，动宾短语
order: 2                          # 同组排序
summary: 一句话说明这页解决什么问题   # 必填：首页卡片 / 列表 / 相关文章处显示
routes: [cuelists]                # 对应产品内路由，nav-config 口径：cuelists / admin/roles / /my/tasks
who: 有「Cue 表管理」权限的成员      # 谁能用；不写 = 所有成员
tier: all                         # all | free | pro；文案取 PRODUCTION_TIERS[tier].label，档位改名自动跟
platform: [desktop, mobile]       # 不写 = 两端
related: [creation/cues/link-to-script]
updated: 2026-09-18               # 必填 YYYY-MM-DD
---
```

`who` / `tier` / `platform` 自动渲染成标题下的「适用范围」块，正文不要再手写一遍。解析器是刻意收窄的 yaml 子集（`lib/help/frontmatter.ts`）：标量、数字、布尔、行内数组 `[a, b]`。

### 12.3 正文写法

**读者是剧组里搞艺术的人**（导演、舞监、演员、设计师），不是开发者。硬规则：

1. **去技术化**：正文不出现路由（`/login`）、代码、字段名、环境变量、「浏览器站点数据」这类词。界面上的按钮 / 菜单用「」原样引用，位置写成人话（右上角头像 → …）。
2. **只写现状，没有「如果」**：这是我们自己部署的服务，功能有就是有、没有就是没有。现在是邀请制就写邀请制，以后改了就改手册。
3. **站在读者那边**：先说他要做什么、会看到什么，再说注意什么；常见问题用读者会问的原话做标题。
4. **快捷键同时给 Mac / Windows**：写成 `⌘/Ctrl+F`，表格分两列。
5. **界面元素用读者的词**：chip 是「卡片」不是「芯片」、badge 是「角标」、modal 是「窗口」、tab 是「页签」、dropdown 是「下拉」、toast 是「提示条」、drawer 是「抽屉」、toggle 是「开关」。
6. **不训话**：不写「AI 助手不是许愿机」「别这样干」式的否定祈使；改成 hints——条件、代价、更好的做法（「简短明确的指令效果更佳」「长任务更耗 token」）。
7. **管理动作教操作者自己核实**：撤权 / 授权 / 审批的结果是管理员的责任，写「怎么确认生效了」时先找产品里能让操作者自己看到结果的地方（审计流水、状态列、筛选），写成「筛选设成 X + Y，剩下的就是……」；「让对方刷新试试」只在真的没有核实手段时才写。

- 固定四节 `## 这是什么` `## 怎么操作` `## 注意事项` `## 常见问题`（覆盖测试会查）。操作步骤用编号列表，一步一图。
- 提示框用知识库同款 callout：`> [!💡]` 提示、`> [!📱]` 窄窗口差异、`> [!⚠️ bg=#f5edda]` 警告。不引入 tabs 等新方言。
- 站内互链写相对 slug（`../cues/create`）或 `/help/<slug>`；外链自动新窗口打开。
- 渲染管线是 `components/help/HelpMarkdown.tsx`（react-markdown + gfm，服务端组件）；**不要**改用 `WikiMarkdown`——那条管线绑着 wiki 方言与观看者解析。
- 截图法：`npm run seed:local-demo` 的虚拟项目，用 `createSession` 给虚拟成员签本地 cookie，playwright `channel: "chrome"` + 真实 viewport 截；手机宽度核对不要用无头 Chrome 的 `--window-size`（macOS 上最小布局宽 500，400 宽会假报溢出）。

### 12.4 覆盖棘轮（`tests/help/manual-coverage.test.ts`）

- nav-config 里每个入口必须映射到一篇手册页（`routes`），否则要列进 `MISSING_ALLOWED`。名单**只减不增**：往侧栏加新功能 = 同 PR 补手册页；内容 issue 合并时把对应路由从名单划掉；已有页的路由留在名单里会红。
- `routes` 只能写已知路由（导航口径或测试里的 `EXTRA_ROUTES`）。
- `related`、`_home.md`、正文互链必须指向存在的页；图片必须在 `public/manual/`。

### 12.5 功能 PR 必须同步手册页（规约）

凡是改了用户可感知行为的 PR——加 / 删菜单项、改按钮文案、改流程步骤、改权限边界、改档位限制——**同一 PR 里改对应的 `content/manual/**/*.md`**，并把 frontmatter `updated` 改成当天。判断标准：手册里有没有一句话因为这个 PR 变得不对了。删功能就删掉对应页或段落，别留「即将」「暂不」。手册页也是 review 对象。

### 12.6 「本页帮助」「报告问题」「搜索」（#538）

| 件 | 在哪 | 怎么工作 |
|---|---|---|
| 本页帮助 | 头像菜单 | `RootLayout` 用 `manualRouteIndex(loadManual())` 算出「产品路由 → 手册 slug」下发 `AppShell`；`components/shell/app-shell/help-link.ts` 把 pathname 归一化成 nav-config 口径的键由具体到泛逐级查，没命中回 `/help` |
| 报告问题 | 头像菜单、每篇手册页底部 | `components/help/BugReportModal.tsx` → `POST /api/bug-reports` → `bug_report` 表。只收登录用户，每人每小时 10 条；自动带 page_path / manual_slug / production_id / user_agent / viewport。落库后经 Resend 抄一封到 `dev@clickinmusical.com`（`BUG_REPORT_INBOX`，联系方式是邮箱时设 reply-to；发送失败只记 console 不影响落库）。**日志表是真相源**：`SELECT … FROM bug_report WHERE status='new' ORDER BY created_at DESC`（或 `listBugReports()`）翻看，上 issue 后回填 `status` / `issue_url` |
| 搜索 | 手册顶栏与首页 | `GET /api/help/search-index`（公开，缓存 1h）给一份轻量索引；`components/help/HelpSearch.tsx` 客户端过滤，打分在 `lib/help/search-score.ts`（零 node 依赖，可进客户端；标题 > 摘要 > 小节 > 面包屑 > 正文，多词 AND） |

### 12.7 相关文件

| 文件 | 作用 |
|---|---|
| `lib/help/manual.ts` | 目录树加载、frontmatter 校验、标题锚点、路由索引 |
| `components/help/*` | 顶栏、左树、适用范围块、页内目录、正文渲染、`help.css` |
| `app/help/` | 首页 `/help`、文章 `/help/[...slug]` |
| `proxy.ts` | `/help` `/manual/` `/api/help/` 列为公开前缀 |
| `lib/help/bug-report-db.ts` `app/api/bug-reports/` | 报告问题落库与接口 |
| `lib/help/search-index.ts` `lib/help/search-score.ts` `app/api/help/search-index/` | 搜索索引（带 fs）/ 打分（纯函数）/ 接口 |
| `components/shell/app-shell/help-link.ts` | 本页帮助的路由归一化 |
| `next.config.ts` | `outputFileTracingIncludes` 圈进 `content/manual/**` 与 `content/changelog/**`（standalone 不追踪 fs 读） |
| `lib/help/changelog.ts` `lib/help/changelog-seen.ts` | 更新日志加载 / 红点「看过没有」（§12.8） |
| `app/help/changelog/` `scripts/changelog-release.ts` | 更新日志页 / 发版卷起脚本 |

### 12.8 更新日志（#569）

`/help/changelog` 是给用户看的版本记录：头像菜单「更新日志」、手册顶栏、手册首页都能进；有没看过的新版本时头像亮红点（键是最新版本号，存 localStorage，不进库）。手册页顶部若有已发版本提到这页，显示「某日的更新改了这页说的功能」。

**不是 commit message 拼接**。读者是导演 / 舞监，`chore(db): #486 项目本体搬出 db.ts` 对他们是噪音，`fix(collab): #578 在场心跳` 得翻译成「安静读剧本的人不再从在线头像里消失」。翻译没法机械做，所以日志是人写的独立内容——**改手册页的那个 PR 顺手写一条**，发版时卷成一个版本。

```
content/changelog/
├── _TEMPLATE.md               # 作者模板
├── unreleased/                # 已合并、还没随 tag 发到 prod 的条目；每 PR 一个文件（避免冲突）
│   └── 566-calendar-inline-edit.md
└── v0.1.2-260924/             # 目录名 = git tag（形态见 §4「版本号」）；发版脚本从 unreleased/ 搬进来
    ├── _index.md              #   date（必填）/ summary
    └── 566-calendar-inline-edit.md
```

条目 frontmatter：`kind`（new 新增 / improved 优化 / fixed 修复 / removed 下线）、`title`（必填，一句话）、`page`（对应手册页 slug → 「了解更多」，测试校验存在）、`pr`（unreleased 里必填）、`order`。正文可选：一两句补充或一张截图。

**写法 = 手册写法（§12.3）**，外加：一条只说一件事；修复类写「X 不再 Y」；标题不出现 issue 号 / 路径 / 代码标识（`tests/help/changelog.test.ts` 会拦）。**内部改动不写条目**：改动全在 `content/manual/` `docs/` `tests/` `.github/` `db/` `scripts/` 里的 PR 自动豁免；重构、依赖升级这类碰了代码的内部改动给 PR 打 `chore`（或 `workflow` / `research`）标签。

流程：

| 时机 | 谁 | 做什么 |
|---|---|---|
| 功能 PR | 作者 | 复制 `_TEMPLATE.md` 到 `unreleased/<PR号>-<两三个词>.md`。没写又没打豁免标签，`pr-automation` 会留一条提醒评论（软提醒不红；补上自动删） |
| 发版 | 打 tag 的人 | `npm run changelog:release -- <tag>`：建 `<tag>/_index.md`、`git mv` 碎片进去。**然后人来编辑**：重排、合并、删太细的、补 summary。commit 后再 `git tag` |
| tag 部署 | CD | `deploy.yml` 闸：`content/changelog/<tag>/_index.md` 不存在、或 `unreleased/` 还有条目 → 红。与 schema 指纹同一个逻辑：不许发一个没交代的版本 |

dev 环境（main 自动发）上 `unreleased/` 有条目时页面顶部多一段「即将发布」，测试同学用它知道 dev 上有什么新东西；prod 上发版已卷走，不显示。纯内部版本用 `--allow-empty`，页面显示「这一版没有你能感知到的改动」。

---

## 13. 设计定式与已知的坑

不在 issue / 代码注释里就会被反复重新发明的东西。每条带出处，改动这些定式先看原 issue。

### 13.1 数据模型定式

- **新表 PK 一律 `TEXT PRIMARY KEY` + 应用侧 short id**：`${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`——**必须带随机尾巴**（纯计数器在 pm2 多进程同毫秒会撞 PK）。不要再用 `UUID PRIMARY KEY DEFAULT gen_random_uuid()`：类型一旦是 UUID 就永远换不成 short id。存量 UUID 表不迁移（2026-08-22 定）。
- **分享链接一律走 token 间接层**（照 `asset_share_token`：token PK + `expires_at` / `one_time` / `revoked_at`），实体 id 不进分享 URL——可撤销、可过期、不暴露内部 id；「知道 id ≠ 有权访问」。
- **版本体系已退役**（PR #300）：所有剧只有 head 可见；新设计**完全不考虑「版本迁移」**，不引入 version 维度，不引用「CoW 地基」约束新工作。`version` / `script_version` / `cue_version` / `parent_version_id` 是历史债，纯为迁移麻烦才留着。将来的「历史记录」（#31）不会重建分支语义。
- **node 树契约**（#420）：asset / wiki 壳节点在同一棵 node 树上；挂载边是关系概念不是一张表，各业务自建边表；三条硬约束——node id 寻址、**悬空即删**（边某端实体删了就是删了，不做悬空占位）、**边不投权限票**（可见性由内容门 + 结构让渡算，引用边零权限语义）。业务实体（event / scene …）不进树，靠「缺省落点」把新内容自动放进实体文件夹（`lib/node/landing.ts`）。
- **权限与等级正交**（PR #312）：权限（grant 树，owner / 制作人定）决定视图里**看得到什么内容**，不动菜单结构；等级（`user_plan` / `production_plan`，付费维度）决定**菜单栏里有没有这一项**。代码里分开传（`perms` vs `planXxx`），不得合并成一个布尔；菜单藏了 URL 直达也要挡（服务端 redirect）。`lib/account/plan.ts` 有 pg import，不可入客户端包。用户等级只在建项目一处被消费；功能跟项目走。
- **成员三态**（PR #329）：`production_member.status ∈ active / suspended / exited`。新增成员查询必须选口径：访问判定 / 指派候选 / 通知收件人 → `active`；名册 / 通讯录 / **席位** → `<> 'exited'`（suspended 占席位，为随时原样复职预留）。邀请路径用 `occupiesSeat` 挡座位，不能用 `alreadyMember`。`supervisor_id` 是纯路由字段不携带权限。
- **wiki 可见性**：wiki 名字不敏感、内容敏感——无权观看者可见标题 + 点击进权限申请是常态；可枚举性是节点自身属性且 `E(子) ⊆ E(父)`；不可枚举 = 树里看不到但经链接仍可达；容器写门 = 直接父的 `*@edit`，系统锚点豁免。判定式在 `lib/wiki/perm.ts` 注释里。
- **页码单一口径 = 服务端估算轨 `page_map`**（PR #400）：客户端 DOM 实测不可作共享真相（字体可被浏览器覆盖）；AI / 搜索 / @提及 / 编辑器分页线全组同数。mention 存的是 `[#block.page:<blockId>]` 稳定锚点不是页码。「定稿时刻上传实测覆盖」挂 #401，页码体系与 A 页挂 #349。
- **头像缓存契约三处联动**（PR #419）：presign 生成版本化 key `avatar-<ts>` → `lib/asset/avatar-url.ts` 派生 `?v=` → GET 路由回 `immutable`；改一处必须同改。成员 API 返回的 `avatarUrl` 是 DB 裸值，渲染必须走 helper。裸 `<img>` 是架构决定（standalone VPS 下 `next/image` = 在自己服务器实时 sharp），`no-img-element` 已全局关闭。
- **元数据信封挂 `asset_file` 不挂 `asset`**（#85）：文件行不可变 ⇒ `(fileId, parserVersion)` 键永不失效；版本契约是唯一失效通道——新增分析器忘 bump `BROKER_VERSION` = 存量 unsupported 永不重算。broker 判定：magic 主判 → 扩展名破同门 → 声明 mime 不参与。
- **wiki-asset 嵌入**：存储方言 v2 URI 唯一文法（`![](/__cm__/asset/<id>)`），统一发生在输入层；embed 边由 `syncWikiLinks` 从正文派生（单写入方），前端不直写 mounts。

### 13.2 权限门定式

见 §5：owner 旁路 / isAdmin 死字段 / `hasEffectiveGrant` 族 / 模版≠保证 / 回填只放不收 / 前端开关逐键同源 / 激活后 `router.refresh()` / 写面键登记 scope。另：

- **语境不是权限**：给 AI 的 production-context、页面 UI 上下文等注入内容不承载授权；工具内部照判 `hasEffectiveGrant`。
- **策略开关绝不能否决已有 grant 行**（`production_policy`）；策略管「能力存不存在」，不管每次行使。
- owner 旁路要查 `production.owner_id`，不要查 session 的 `isAdmin`。

### 13.3 Next / React 边界坑

- **客户端组件 import 到带 `node:fs` / `@/lib/pg` 的 lib 模块 → Turbopack 客户端打包解析不到 fs/net/dns → 整站 500（含 `/login`），dev server 看似「挂了」**（#538 事故）。`tsc` 和 vitest 都不会报，只有 dev 日志里有 `⨯ Module not found`。规矩：域内按「`*-types.ts` / `*-score.ts`（零 node 依赖，顶部注释写明）」与「`*-db.ts` / 带 fs 的加载器」分文件，客户端只从前者拿；改完 `lib/` import 后起 dev server 请求 `/login`；用户报「dev 起不来 / 全站不响应」先 `grep 'Module not found' dev.log` 再怀疑进程；修完 import 后重启 dev（Turbopack 残留模块图）。
- **`"use client"` 组件在 SSR 仍渲染一次，渲染期读 `window` 就是 500**（只有事件处理器和 `useEffect` 里安全）。更隐蔽的是 Next 捕获 SSR 异常后降级到客户端渲染，**页面完全正常**，只有 `pm2 logs --err` 每次访问堆一条 `ReferenceError: window is not defined`。删一个「初值 false、effect 里置 true」的状态门前先问它是否在挡 SSR（PR #321→#322）。兜底：`tests/account/login-ssr.test.ts` 那个套路——vitest node 环境 `renderToString(createElement(Comp, props))` 不抛错即通过，把「开关开启」的分支也覆盖到。`lib/server-url.ts` 顶上那句「Never import this in client components」是同一类坑。
- **Next App Router 下 React 的事件监听器就挂在 `document` 上**，与业务 `document.addEventListener("keydown")` 是同一节点的两个监听器，`stopPropagation` 拦不住（要 `stopImmediatePropagation` 又会误伤）。**jsdom 单测里 `createRoot(container)` 比 document 浅一层，`stopPropagation` 却能拦住 ⇒ 测试假绿、生产照坏**。改用 DOM 判据在外层监听器里让行（「DOM 里还挂着 `[data-xxx-menu]` 就把这次按键让给菜单」，时序成立：React 19 sync lane 在微任务 flush，插不进一次原生派发中途），并补「第二次按键外层照常响应」的用例。pointerdown 同理：`closest("[data-task-row], [data-overflow-safe-select-menu]")` 判「点了外面」。
- **client router cache「写时失效」在本仓做不到廉价可靠**（#416 / PR #474 四轮裁决）：写 → setState → 切走 → 30s 内切回命中 bfcache → `useState(initialX)` 从旧 payload 重播种。判缓存安全要问「数据的唯一来源是谁、谁会写它」，不是「本页组件树里有什么」——用户一路点进去的子页面不是「别处」。若复评后仍要做，唯一成立的方向是 SWR-with-RSC（全局 fetch 拦截只置 dirty 位，AppShell 按 pathname 变化若 dirty 则 `router.refresh()`）。
- **粘贴 / 剪贴板功能按「Safari 只有 text/plain + text/html」设防**：WKWebView（含 Tauri 客户端）的 `getData` 不暴露自定义类型（`docx/record` 恒空），只有 Chromium 才有。结构元数据优先从 text/html 内嵌载体取（飞书把 recordMap 嵌在 `span[data-lark-record-data]`），自定义类型只做补充；解析剪贴板 JSON 用 `Object.create(null)` + 跳过 `__proto__` 键。用户群跨内核，没有「主测环境」。
- **单实例是硬约束**：script / cue 协作 SSE 注册表是纯进程内存（只有 wiki 有 outbox + LISTEN 跨进程桥）；`agent-runner` 里广播打的是自己进程的空注册表。横向扩容前必须补桥或换 Redis。

### 13.4 UI 定式

- **新页面 / 改造一律用共享原语**（`components/ui/`：PageHeader / Panel / Badge / 摘要卡 / DropdownPicker / OverflowSafeSelect / TreePickerModal）；draft 事件可见性用 `filterDraftVisibleEvents`，勿内联复制。
- **上下文菜单（三点 / 右键）各 kind 同一套项、同一顺序**：某 kind 不支持某操作时**灰掉 + 给原因**（`aria-disabled` + `title`，不用 `disabled` 属性否则 tooltip 读不到），不许条件渲染让它消失（#511）。写菜单先列固定项表，再给每项算 `disabled reason`。
- **带 panel / 卡片的东西必须对齐**：「grid/flex 容器 → 包裹元素 → 卡片」三层结构时卡片层要 `flex:1` / `height:100%` 撑满（`li > a` 卡片让 `a` 撑满 `li`），发 PR 前用 playwright `getBoundingClientRect().height` 量一遍同排卡片。
- **原生元素换自定义组件**（PR #350 教训）：① 共享原语的默认外观不能写内联 style（压过调用方 class，`focus:*` 变死代码），放 `app/globals.css` 的 `@layer components`（Tailwind v4 层序 theme → base → components → utilities）；② 换掉标签名会让 CSS Module 里 `.formGrid select` 这类选择器静默失配，全库 `grep -rn "select" --include='*.css'` 逐条补 `[role="combobox"]`；③ 别写死 `width: 100%` / `min-height`，用 `inline-flex` 保持与原生一致的收缩行为。判断基准是「和替换前的原生元素表现一致」。
- **文档类界面 Notion 式**：有编辑权即整页就地编辑 + 防抖自动保存 + 状态提示（无编辑权才只读渲染）；新建 / 删除 / 移动 / 树导航全部放左侧栏，文档区只留内容级动作；自动保存注意 effect 闭包旧值（`latestRef`）与「结构性变化才 `router.refresh()`」。
- **写入类 UI 的失败要显形**：乐观更新后 API 失败必须回滚并提示，不能让用户以为保存成功（[TEST_GUIDE.md](./TEST_GUIDE.md) 的「操作丢失」是人工测试重点）。

### 13.5 排查纪律

- **报风险前先查可达性**：后端权限门 → 前端调用点 → 组件是否真的被渲染 → 触发它的 `setState` 是否被调用过。`grep setXxx` 只出现在 `useState` 声明行就说明那条 UI 路径永远打不开。UI v3 改版留下成片孤儿后端分支（端点还暴露、前端零调用方），照着推断出的「风险」是假的，该做的是删孤儿；反过来看着像遗留的也可能仍有活按钮。查到组件只有定义没有渲染点直接说「死代码，应删」。
- **源码混入 `\x00` 会让 git 判二进制**：diff 显示 `Bin`、AI review 对该文件失明、grep 报 "Binary file matches"。需要「不可能碰撞的分隔符」用可打印组合或转义序列文本，绝不落字面控制字节；提交前 `git diff --stat` 见文本文件出 `Bin` 立即排查。
- **`.gitignore` 裸规则匹配任意目录下同名文件，`git add` 对被 ignore 的路径静默跳过**；验证 ignore 规则一律 `git check-ignore --no-index -v`（默认查 index，对已 tracked 文件永远沉默），防回归断言用 `git ls-files` 对比磁盘清单。
- **「文件即事实」优先于「prompt 里现场更正」**：共用文件分叉时留下的更正块，等消费方唯一化后必须回收；协议方消失后前向兼容的前端分支与预留字面量就是死支路，留着只会伪装成「有这功能」。
- **AI review 对格式解析器的「应显式拒绝」类建议必须过真文件回归再采纳**（bplist 的 16 字节 int 在真 qlab 工程里合法）。
- 线上只读排查可直接 ssh（`click-in-prod` / `click-in-dev`），别 dump `shared/.env.local` 的值；新机恢复库后除指纹外还要扫一遍 ACL（`has_table_privilege`），指纹看不到权限。
