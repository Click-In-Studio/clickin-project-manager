# 开发指南

## 目录

1. [项目结构](#1-项目结构)
2. [技术栈](#2-技术栈)
3. [本地开发](#3-本地开发)
4. [权限模型](#4-权限模型)
5. [数据库](#5-数据库)
6. [文件存储（R2）](#6-文件存储r2)
7. [飞书集成](#7-飞书集成)
8. [Agent Bot](#8-agent-bot)
9. [新增功能典型流程](#9-新增功能典型流程)
10. [单元测试](#10-单元测试)

---

## 1. 项目结构

```
/
├── app/                    # Next.js App Router 页面和 API
│   ├── api/                # API routes
│   │   ├── auth/           # 飞书 OAuth、登录、登出
│   │   ├── production/[id]/# 剧目相关 API（assets、events、cuelists 等）
│   │   ├── my/             # 当前用户相关（通知、权限）
│   │   └── internal/       # 内部 cron 接口（通知触发）
│   ├── production/[id]/    # 剧目子页面（剧本、段落、Cue、Asset 等）
│   ├── my/                 # 个人页面（通知、权限、周 call、日 call）
│   └── login/              # 登录页
│
├── components/             # React 客户端组件
│   ├── assets/             # Asset 相关组件（上传、预览、挂载）
│   └── ...                 # 其他功能组件
│
├── lib/                    # 服务端工具库
│   ├── db.ts               # 主数据库查询（production、member、permission）
│   ├── asset-db.ts         # Asset 数据库操作
│   ├── event-db.ts         # 事件/日程数据库操作
│   ├── r2.ts               # Cloudflare R2 presigned URL、multipart upload
│   ├── roles.ts            # 权限角色定义与 hasPermission()
│   ├── session.ts          # Cookie session（HMAC 签名，无服务端状态）
│   ├── feishu-auth.ts      # 飞书 OAuth
│   ├── feishu-bot.ts       # 飞书 Bot 消息发送
│   ├── notify.ts           # 通知触发逻辑
│   └── ...                 # 其他工具
│
├── agent/                  # 飞书群机器人（独立隔离，见第 8 节）
│   ├── index.ts            # 入口：processMessage(ctx)
│   ├── db.ts               # Agent 专用数据库查询
│   ├── types.ts            # BotContext 和共享类型
│   └── llm.ts              # LLM 接口（OpenAI-compatible）
│
├── db/                     # SQL 迁移文件（schema.sql + migrate-*.sql）
│
└── docs/                   # 项目文档
```

---

## 2. 技术栈

| 层 | 选型 |
|----|------|
| 框架 | Next.js 16 App Router（TypeScript） |
| 样式 | Tailwind CSS |
| 富文本 | TipTap（剧本编辑器） |
| 数据库 | PostgreSQL（`pg` 原生驱动，无 ORM） |
| 文件存储 | Cloudflare R2（S3 兼容，AWS Signature V4 手写） |
| 身份验证 | 飞书 OAuth 2.0，HMAC 签名 Cookie session |
| 音频波形 | WaveSurfer.js v7（动态 import） |
| Bot LLM | OpenAI-compatible API（模型由 `OPENAI_MODEL` 环境变量指定） |

### Next.js 说明

本项目使用 Next.js **16**，部分 API 与旧版本有差异：

- Route Handler 的 `params` 是 `Promise`，需要 `await ctx.params`
- `cookies()` 和 `headers()` 是异步函数
- `basePath` 设为 `/app`（见 `next.config.ts`）

在编写路由或中间件前请先阅读 `node_modules/next/dist/docs/` 中的相关说明。

---

## 3. 本地开发

### 环境变量

复制 `.env.example` 为 `.env.local`，按注释填写：

```
# 飞书应用
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_REDIRECT_URI=http://127.0.0.1:3000/app/api/auth/feishu-code

# 数据库（主库）
PGHOST=localhost
PGDATABASE=script_editor
PGUSER=script_editor
PGPASSWORD=

# Agent Bot 数据库（独立库）
AGENT_PGHOST=localhost
AGENT_PGDATABASE=click_in_agent
AGENT_PGUSER=agent_user
AGENT_PGPASSWORD=

# Cloudflare R2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=click-in-test   # 本地用测试 bucket

# 应用
APP_BASE_URL=http://127.0.0.1:3000
INTERNAL_NOTIFY_SECRET=any-local-secret

# LLM（Agent Bot 用）
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
```

### 数据库初始化

```bash
# 主库
sudo -u postgres createdb script_editor
sudo -u postgres psql -d script_editor -f db/schema.sql

# Agent 库
sudo -u postgres psql -f db/setup-agent-db.sql
```

### 启动开发服务器

```bash
npm install
npm run dev
```

访问 `http://127.0.0.1:3000/app`（注意：飞书 OAuth 的回调 URL 必须是 `127.0.0.1`，不是 `localhost`）。

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

---

## 4. 权限模型

权限由三层叠加决定：

1. **超级管理员（isAdmin）**：登录时从飞书 `is_tenant_manager` 读取，写入 session cookie。SA 拥有全部权限。
2. **角色（roles）**：每个用户在每个剧目中可有多个角色（如 `director`、`stage_manager`），角色决定权限集合。
3. **手动覆盖（overrides）**：可以为单个用户在特定剧目中覆盖某项权限（允许或拒绝），优先于角色推导。

权限检查统一使用 `lib/roles.ts` 中的 `hasPermission(permKey, isAdmin, roles, overrides)`。

---

## 5. 数据库

### 两个数据库

| 库 | 用途 | 连接配置 |
|----|------|---------|
| `script_editor` | 主业务数据 | `PG*` 环境变量 |
| `click_in_agent` | Bot 对话、记忆 | `AGENT_PG*` 环境变量 |

两库完全独立，不做跨库 join。

### Schema 文件

- **`db/schema.sql`** — 主库（`script_editor`）的完整规范 schema，幂等，可在空库或现有库上重复执行。涵盖所有 44 张表、枚举类型和索引。
- **`db/setup-agent-db.sql`** — Agent 库（`click_in_agent`）的一次性初始化脚本（含建库、建用户、建 4 张表）。

首次部署时：

```bash
# 主库
sudo -u postgres psql -d script_editor -f /var/www/production-manager/db/schema.sql

# Agent 库（仅首次，需先修改 CHANGE_ME 密码）
sudo -u postgres psql -f /var/www/production-manager/db/setup-agent-db.sql
```

### 新增 Schema 的约定

开发过程中如需新增表或字段，直接在 `db/` 目录下新建一个描述性 SQL 文件（如 `db/add-something.sql`），并在文件顶部注释中注明：

1. **依赖**：该文件依赖哪些已有的表/字段（新文件必须在依赖已执行完后再跑）
2. **用途**：简要说明变更内容

```sql
-- db/add-something.sql
-- 依赖：production 表、feishu_user 表
-- 用途：新增 XXX 功能所需的 something 表

ALTER TABLE production ADD COLUMN IF NOT EXISTS new_col TEXT;
CREATE TABLE IF NOT EXISTS something ( ... );
```

**CI 自动执行**：merge 到 main 后，CI 按文件的 **git commit 顺序**自动在服务器上执行尚未运行的文件（同一 commit 内的多个文件按字母序排列）。执行记录保存在服务器 `shared/db-applied.txt`。

执行完毕后，同步更新 `db/schema.sql`，将该变更合并进去（保持 schema.sql 始终是当前生产状态的完整快照）。

> ⚠️ **严禁在应用代码（`lib/`、`app/`）中执行任何 DDL（`ALTER TABLE`、`CREATE TABLE`、`DROP`、`TRUNCATE` 等）。**
>
> 原因：应用 DB 用户（`script_editor`）以 `GRANT` 方式获得 DML 权限，但**不是表的 owner**，执行 DDL 会报 `must be owner of table`（PostgreSQL 42501），导致请求 500。所有 schema 变更必须通过 `db/add-*.sql` 由 CI 以 `postgres` 用户身份执行。

### Migration 文件的修改规则

Migration 文件一经 commit，**只允许 chore 类修改**（注释、格式、typo），**不允许任何实质性的 SQL 修改**。

原因：CI 以文件名为 key 记录是否已执行，修改文件内容不会触发重新执行，改动会静默丢失。

如果需要修正已提交的 migration（如 ALTER TABLE 语句有误）：

```
❌ 错误：直接修改 db/add-something.sql
✅ 正确：新建 db/fix-something.sql，写补丁 SQL
```

### 时区约定

- 数据库所有时间字段使用 `TIMESTAMPTZ`，存储 UTC。
- 面向用户展示时转为 UTC+8（CST）。
- 工具函数在 `lib/tz.ts`。

---

## 6. 文件存储（R2）

### Key 命名规范

```
assets/{assetFileId}/{safeFileName}   # 资产文件
thumbnails/{assetFileId}.webp         # 缩略图
```

函数在 `lib/r2.ts`：`assetR2Key()`、`thumbnailR2Key()`。

### Presign 流程

R2 不经过服务器中转，客户端直接 PUT：

1. 客户端调 `/api/.../presign` → 服务端生成 presigned PUT URL 返回
2. 客户端用 XHR 直接 PUT 到 R2
3. 上传完成后，客户端 POST `/api/.../assets` 注册元数据到数据库

大文件（>50MB）走 multipart upload，流程类似但分片并行上传。Multipart 完成时由服务端调 `listMultipartParts()` 从 R2 直接获取各分片 ETag，不依赖客户端传值（浏览器无法读取 CORS 跨域响应的 ETag header）。

### AWS Signature V4 注意事项

`lib/r2.ts` 手写 AWS Sig V4 实现：
- `sortedParams()` 按**字节序**排序（`X`(0x58) < `r`(0x72)），不用 `localeCompare`。
- presigned GET 加 `response-content-disposition=inline` 和 `response-content-type` 参数可让浏览器内嵌展示而非下载。

---

## 7. 飞书集成

### OAuth 登录流程

```
用户点击登录
  → /api/auth/login  → 重定向到飞书授权页
  → 飞书回调 /api/auth/feishu-code  → 换 token → 写 session cookie → 重定向首页
```

Session 存为 HMAC 签名的 Cookie，不需要服务端 session store。内容：`{ openId, name, avatarUrl, isAdmin }`。

### Bot（飞书群消息）

飞书群消息经 webhook 进入 `/api/feishu-webhook`，由 `agent/index.ts` 的 `processMessage()` 处理。

---

## 8. Agent Bot

Agent 与主业务**完全隔离**，有严格限制：

- `agent/` 只能从 `lib/roles.ts` 引入外部代码，其他 `lib/*` 全部禁止。
- 数据库访问只能通过 `agent/db.ts`，连接 `click_in_agent` 库（独立配置）。
- 不得使用 Next.js API（`cookies()`、`NextRequest` 等）。
- 唯一允许调用 `agent/` 的文件是 `app/api/feishu-webhook/route.ts`。

如需 Agent 读取主业务数据，在 `agent/db.ts` 里单独写查询，连接主库（`PG*` 变量）即可，但保持函数级隔离。

---

## 9. 新增功能典型流程

以"给剧目新增一个子页面"为例：

### 步骤一：数据库（如需新表/字段）

1. 在 `db/add-xxx.sql` 写 `ALTER TABLE` 或 `CREATE TABLE`。
2. 在 `lib/` 对应的 `*-db.ts` 文件（或新建一个）里加查询函数。

### 步骤二：API

在 `app/api/production/[id]/your-feature/route.ts` 创建 Route Handler：

```typescript
import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { canUserAccessProduction } from "@/lib/db";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;          // Next.js 16: params 是 Promise
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const ok = session.isAdmin || (await canUserAccessProduction(session.openId, id));
  if (!ok) return Response.json({ error: "权限不足" }, { status: 403 });
  // ...业务逻辑
}
```

### 步骤三：页面

在 `app/production/[id]/your-feature/page.tsx` 创建 Server Component：

```typescript
import { cookies } from "next/headers";
// 做服务端 auth 检查，然后渲染客户端组件
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // ...
}
```

客户端逻辑放在 `components/YourFeatureClient.tsx`（`"use client"`）。

### 步骤四：导航

在对应的 sidebar/nav 组件里加入新页面的链接。使用 `<Link href="/production/{id}/your-feature">` 而**不是**手动拼 `BASE_PATH`——`<Link>` 会自动加 basePath。只有在 `fetch()`、`<a href>`、`window.location` 等非 Link 场景下才需要 `${BASE_PATH}/...`。

### 步骤五：部署

```bash
# 执行数据库迁移（如有）
ssh click-in "sudo -u postgres psql -d script_editor -f /var/www/production-manager/db/migrate-xxx.sql"

# 同步代码并重启
rsync -a --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='.env.local' \
  ./ click-in:/var/www/production-manager/
ssh click-in "cd /var/www/production-manager && npm install && npm run build && pm2 restart production-manager --update-env"
```

---

## 10. 单元测试

### 10.1 定位与目标

本项目的测试套件以**预防为目的**，不是事后审计。每条测试都是对一条不变量的断言——随着代码演化，只要这条不变量被破坏，CI 就立即报告，而不是等到上线后才发现。

测试运行器为 **Vitest**，直接连接测试数据库（与 CI 环境相同的 `script_editor` 库，seed 数据来自 `seed-data/ci.sql`）。

```bash
npm test           # 跑全部测试（vitest run）
npm test -- --reporter=verbose  # 显示每条测试名称
```

### 10.2 测试文件结构

```
tests/
├── global-setup.ts      # 所有测试共用的 DB 生命周期（setup / teardown）
├── helpers.ts           # 常量：PROD_PLANET、PROD_CULTURE、TEST_USER
├── production.test.ts   # DB 层：production CRUD
├── dramaturgy.test.ts   # DB 层：场景、角色
├── script.test.ts       # DB 层：版本、脚本加载
├── cue.test.ts          # DB 层：cue list / cue CRUD
├── event.test.ts        # DB 层：排练事件、日程
├── security.test.ts     # 跨 production 数据隔离
├── resilience.test.ts   # 幂等性、并发、边界输入、级联删除
├── api.test.ts          # API 层：route handler 认证 / 鉴权 / 输入校验
├── api-race.test.ts     # API 层：竞态条件、网络波动模拟
└── conventions.test.ts  # 开发规约自动化（见 10.5 节）
```

`tests/helpers.ts` 中定义了两个真实 seed 演出和一个测试用系统账号：

```typescript
export const PROD_PLANET  = "mod1uc2dg";   // 我们的星星
export const PROD_CULTURE = "mon0jcm82";   // 供养2.0
export const TEST_USER    = "test-sys-user";
```

`TEST_USER` 在 `global-setup.ts` 的 `setup()` 阶段插入 `feishu_user`，`teardown()` 时删除。所有测试文件共用这一账号，**不要在单个测试文件里重复创建或删除它**。

### 10.3 DB 层测试规范

DB 层测试直接调用 `lib/db.ts` / `lib/event-db.ts` 中的函数，不经过 HTTP 层。

#### 测试 ID 命名

测试中创建的资源 ID 必须以 `test-` 开头，例如 `test-prod-unit`、`test-cl-unit`。`seed-schema.json` 的结构比对会自动排除 `table_name LIKE 'test-%'` 的行，但 **ID 前缀是保证测试数据不污染 fingerprint 查询的关键**。

#### 清理规则

每个创建资源的测试文件必须在 `afterAll` 里清理自己创建的资源，且要加 `.catch(() => {})` 防止前序测试失败导致级联错误：

```typescript
afterAll(async () => {
  await deleteCue(CUE_ID, CL_ID).catch(() => {});
  await deleteCueList(CL_ID, PROD_ID).catch(() => {});
  await deleteProduction(PROD_ID).catch(() => {});
});
```

级联删除（如删除 production 时子资源自动删除）是允许的，不需要逐一删除子资源。

#### 不要修改种子演出的核心数据

`PROD_PLANET` 和 `PROD_CULTURE` 是 seed 演出，其剧本、场景、角色等核心数据**只读**。可以在这两个演出上创建新的走位表或排练事件（并在 afterAll 清理），但不可修改其已有数据。如果测试需要可写的演出，用 `createProduction` 创建专属测试演出。

#### 断言 vs 脆弱断言

对 seed 数据的读操作使用宽松断言（`toBeGreaterThan`、`toBeTruthy`、`toContain`），避免对具体行数或内容使用精确相等，因为 seed 数据未来可能更新：

```typescript
// ✅ 推荐
expect(scenes.length).toBeGreaterThan(0);
expect(ids).toContain(PROD_PLANET);

// ❌ 避免（seed 更新后会误报）
expect(scenes.length).toBe(34);
```

### 10.4 API 层测试规范

API 层测试**直接 import 并调用 route handler 函数**，不需要启动 HTTP 服务器。Next.js App Router 的 route handler 是普通 TypeScript 函数，可以在 Vitest 中直接调用。

#### Session 构造

使用 `lib/session.ts` 的 `createSession()` 构造合法或故意损坏的 session cookie：

```typescript
import { createSession, SESSION_COOKIE } from "@/lib/session";

function adminSession() {
  return createSession({ openId: TEST_USER, name: "测试员", avatarUrl: null, isAdmin: true });
}

function req(url: string, opts: { session?: string; method?: string; body?: string } = {}) {
  const headers = new Headers();
  if (opts.session) headers.set("cookie", `${SESSION_COOKIE}=${opts.session}`);
  return new NextRequest(`http://localhost${url}`, { method: opts.method, body: opts.body, headers });
}
```

#### 路由参数 ctx

带路径参数的 route handler 需传第二个参数 `ctx`：

```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(params: Record<string, string>): any {
  return { params: Promise.resolve(params) };
}

// 调用示例
const res = await listCueListsHandler(
  req(`/api/production/${PROD_PLANET}/cuelists`, { session: adminSession() }),
  ctx({ id: PROD_PLANET }),
);
```

#### 权限注意事项

部分权限有 `adminBypass: false`（如 `script:edit`、`script:metadata`），**超级管理员也不能绕过**。这类测试需要在 DB 里给 `TEST_USER` 加成员角色：

```typescript
await addProductionMember(TEST_USER, PROD_ID);
await setMemberRoles(PROD_ID, TEST_USER, ["制作人"]);
// 然后使用 isAdmin: false 的 session
```

记得在 `afterAll` 里 `removeProductionMember` 或直接删除测试演出。

### 10.5 开发规约自动化测试（conventions.test.ts）

`tests/conventions.test.ts` 包含三条自动化规约检查，CI 和本地 `npm test` 都会跑。

#### ① 运行时 DDL 静态扫描

扫描 `lib/` 和 `app/api/` 中所有 `.ts` 文件，检测 SQL 执行上下文（template literal 内部或 `.query(` 调用行）中出现的 DDL 关键词（`ALTER TABLE`、`CREATE INDEX`、`DROP TABLE` 等）。

**豁免**：在违规行末尾加注释 `// ddl-check-ignore`。仅在有充分理由时使用（如读取外部 SQL 文件后经 strip 再执行）。

> 背景：应用 DB 用户（`script_editor`）只有 DML 权限，运行时 DDL 会导致 PostgreSQL `42501 permission denied` 错误。所有 schema 变更必须通过 `db/add-*.sql` 以 `postgres` 用户身份执行（见第 5 节）。

#### ② 运行时 Migration 幂等性

对每个运行时 migration 函数（目前仅 `ensureScriptMarkerMigration`），验证：

- 对已 seed 的 DB 调用后立即返回 `{ status: "ready" }`（seed 数据已是迁移后状态）
- 调用两次，`script_version` 行数不变

**新增运行时 migration 的规则**：每当在应用代码中新增一个运行时 migration 函数，必须在 `conventions.test.ts` 中同步添加对应的幂等性测试，否则 PR 不应被合并。

典型模式：

```typescript
it("ensureNewFeatureMigration: seeded data returns ready immediately", async () => {
  const versionId = await getActiveVersionId(PROD_PLANET);
  const result = await ensureNewFeatureMigration(versionId!);
  expect(result.status).toBe("ready");
});

it("ensureNewFeatureMigration: idempotent", async () => {
  const versionId = await getActiveVersionId(PROD_PLANET);
  const before = await getPool().query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM relevant_table WHERE version_id = $1", [versionId]
  );
  await ensureNewFeatureMigration(versionId!);
  const after = await getPool().query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM relevant_table WHERE version_id = $1", [versionId]
  );
  expect(after.rows[0].count).toBe(before.rows[0].count);
});
```

#### ③ Schema Fingerprint 检查

CI 每次跑测试时，将当前 DB 的列结构与 `db/seed-schema.json` 做精确比对。

**触发时机**：当 `db/add-*.sql` 或 `db/schema.sql` 变更后，fingerprint 和 seed 都需要同步更新：

```bash
# 1. 在本地 apply 新 migration
psql -d script_editor -f db/add-new-feature.sql

# 2. 更新 fingerprint
npm run seed:schema     # 写入 db/seed-schema.json

# 3. 重新导出 CI seed（需连接生产/staging DB，或在已迁移的本地 DB 上导出）
npm run seed:ci-export  # 写入 R2 seed-data/ci.sql

# 4. 提交 db/seed-schema.json（ci.sql 已上传 R2，不在 git 里）
git add db/seed-schema.json
```

fingerprint 比对失败时，CI 会给出明确提示：

```
Schema has drifted from db/seed-schema.json.
Run "npm run seed:schema" and commit db/seed-schema.json,
then re-export the seed with "npm run seed:ci-export".

  production.new_col: COLUMN ADDED (re-export seed)
```

### 10.6 覆盖范围约定

| 类型 | 覆盖要求 |
|------|---------|
| 新增 DB 函数（`lib/db.ts` / `lib/event-db.ts`） | 建议在对应 `*.test.ts` 中加 happy path + 参数错误的基础测试 |
| 新增 API route | 建议在 `api.test.ts` 中加 auth guard + 输入校验 + happy path |
| 新增运行时 migration | **必须**在 `conventions.test.ts` 中加幂等性测试 |
| Schema 变更（`db/add-*.sql`） | **必须**更新 `db/seed-schema.json`（`npm run seed:schema`）并重新导出 seed |
| VCS / version 相关逻辑 | 暂不强制（逻辑较复杂，留待专项处理） |
| 流式路由（SSE）、R2、飞书 Bot | 暂不强制（依赖外部服务，需独立策略） |

> **最低要求**：PR 合并前 `npm test` 必须全部通过。新增代码的测试覆盖不做硬性数字要求，但"必须"项是合并阻断条件。
