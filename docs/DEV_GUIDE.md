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

被保护的不变量按优先级分两级：

**Top Priority — 数据完整性**

不论怎么操作、不论误操作、不论并发场景，数据不能乱。具体表现为：

- 不能出现重复条目（duplicate key）
- 不能出现孤儿条目（orphan rows——父记录已删、子记录仍存在）
- 并发写入不能破坏状态一致性（advisory lock、last-write-wins 均需验证）
- 级联删除必须全量触发

数据一旦损坏，很难在不停服的情况下修复，且往往静默破坏后续功能，因此优先级最高。

**P1 — 数据安全性**

没有权限的用户不能读取或修改他人数据。具体表现为：

- 跨 production 的读/写请求被拒（隔离性）
- 未登录、session 篡改/过期均返回 401
- 权限不足返回 403，且不能通过猜测 ID 绕过
- `adminBypass: false` 权限（如 `script:edit`）即使超管也必须持有对应角色

两者同样重要——数据完整性排在前面，是因为一旦破坏几乎不可逆；安全性问题原则上可以在不损失数据的前提下修补。

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

# 2. 更新 fingerprint（见下方关键注意事项）
npm run seed:schema     # 写入 db/seed-schema.json

# 3. 重新导出 CI seed（需连接生产/staging DB，或在已迁移的本地 DB 上导出）
npm run seed:ci-export  # 写入 R2 seed-data/ci.sql

# 4. 提交 db/seed-schema.json（ci.sql 已上传 R2，不在 git 里）
git add db/seed-schema.json
```

> **关键注意事项：`seed:schema` 必须在"干净 DB"上运行。**
>
> `npm run seed:schema` 直接连接 `.env.local` 里指定的本地 DB。如果该 DB 还包含未合并 feature 分支的表（例如另一个本地分支曾经在同一个 DB 上跑过 migration），生成的 fingerprint 就会含有 CI DB 里不存在的表，导致 CI 报"TABLE DROPPED"。
>
> **正确做法**：运行 `seed:schema` 前，确保目标 DB 只有 `db/schema.sql` + 已合并到 main 的 migration 文件，没有本地 feature 分支的表。如有疑问，可临时建一个干净 DB 验证：
>
> ```bash
> psql -d script_editor -c "CREATE DATABASE schema_ci_tmp;"
> psql -d schema_ci_tmp -f db/schema.sql
> # 依次 apply 所有已合并的 add-*.sql
> PGDATABASE=schema_ci_tmp npm run seed:schema
> psql -d script_editor -c "DROP DATABASE schema_ci_tmp;"
> ```

fingerprint 比对失败时，CI 会给出明确提示：

```
Schema has drifted from db/seed-schema.json.
Run "npm run seed:schema" and commit db/seed-schema.json,
then re-export the seed with "npm run seed:ci-export".

  production.new_col: COLUMN ADDED (re-export seed)
  notification_job: TABLE DROPPED   ← 说明 fingerprint 包含了未合并 feature 表，需在干净 DB 上重新生成
```

### 10.6 覆盖范围约定

优先级对应 §10.1 的两级原则：**Top** 保数据完整性，**P1** 保安全性。

| 优先级 | 类型 | 覆盖要求 |
|--------|------|---------|
| **Top** | 新增会修改数据的 DB 函数 | **必须**在对应 `*.test.ts` 中加重复 ID 抛错、并发只有一个成功、删除后不可读的完整性验证 |
| **Top** | 级联关系变更（外键、ON DELETE） | **必须**在 `resilience.test.ts` 中验证级联删除全量触发、无孤儿行 |
| **Top** | 并发写入路径（advisory lock、唯一约束） | **必须**在 `api-race.test.ts` 中验证并发结果的一致性 |
| **P1** | 新增 API route | **必须**在 `api.test.ts` 中加 auth guard（无 cookie → 401）和 authorization（非成员/非管理员 → 403）；`adminBypass:false` 路由还需验证 wrong-role → 403 |
| **P1** | 新增跨 production 的读写操作 | **必须**在 `security.test.ts` 中加"错误 productionId → null / no-op"验证 |
| — | 新增读操作 DB 函数 | 建议加 happy path + 不存在时返回 null 的测试 |
| — | 新增运行时 migration | **必须**在 `conventions.test.ts` 中加幂等性测试 |
| — | Schema 变更（`db/add-*.sql`） | **必须**在干净 DB 上更新 `db/seed-schema.json`（`npm run seed:schema`）并重新导出 seed |
| — | 破坏性 Schema Migration | **必须**提供 `tests/<name>.migration.test.ts`，含 invariance 测试（见 §10.7）|
| — | 流式路由（SSE）、R2、飞书 Bot | 暂不强制（依赖外部服务，需独立策略） |

> **合并阻断条件**：`npm test` 全部通过，且上表标注"**必须**"的覆盖项不能留白。

### 10.7 破坏性 Schema Migration 测试

#### 什么是"破坏性 Migration"

删除列、重命名列、将 TEXT 外键改为 UUID 等操作统称为破坏性 migration（区别于只新增列/表的增量 migration）。破坏性 migration 具有两个特殊性：

1. **不可 git-revert 数据**：`git revert` 只回滚代码，DB 里被删除的列和被转换的值无法自动恢复。回滚必须依赖 DB 备份。
2. **PR-specific 生命周期**：migration 测试对应特定版本的数据转换，与被合并的代码一起生效一次，之后不再需要。但文件保留在仓库中作为历史记录。

#### 三层测试结构

每个破坏性 migration 测试文件应按以下三层组织，缺一不可：

| 层级 | describe 名称 | 作用 | 危险度 |
|------|-------------|------|--------|
| **Schema 验证** | `schema verification` | 列类型、NOT NULL、列是否存在/消失 | 低 — 不会遗漏数据问题 |
| **完整性验证** | `integrity verification` | FK 无孤儿行、UNIQUE 无重复、JSONB 无残留旧 key | 中 — 能发现引用断裂，但不能发现错误映射 |
| **Invariance 验证** | `invariance verification` | 逐行对比迁移前后 FK 映射，确认 ID 没有错误对应 | **高** — 这是唯一能捕获静默数据腐化的测试 |

> **Schema/Integrity 检查不够**：即使所有 FK 都合法、所有行数都对，数据仍可能因为 JOIN 顺序错误、条件遗漏等原因被映射到错误的 ID。Invariance 测试才是关键防线。

#### Invariance 测试模式

在 migration 执行**之前**，快照每个迁移表中的原始 FK 值（旧 open_id、TEXT 等）。执行迁移**之后**，通过新 FK（user_id）反查身份表（feishu_user 等），验证映射回来的旧 ID 与快照一致。

```typescript
// 快照格式（migration 执行前捕获）
type FkRow = { key: string; openId: string };
let snapshot: { counts: Record<string, number>; rows: { someTable: FkRow[] } } | null;

// 验证模式
it.skipIf(!snapshot)("someTable: every user_id resolves to original open_id", async () => {
  const expected = new Map(snapshot!.rows.someTable.map((r) => [r.key, r.openId]));
  const { rows } = await getPool().query("SELECT id, user_id FROM some_table");
  const mismatches: string[] = [];
  for (const row of rows) {
    const resolved = await resolveUserIdToOpenId(row.user_id); // via identity bridge table
    if (resolved !== expected.get(row.id)) {
      mismatches.push(`id=${row.id}: expected ${expected.get(row.id)}, got ${resolved}`);
    }
  }
  expect(mismatches).toEqual([]);
});
```

`it.skipIf(!snapshot)` 保证：有快照时强制跑（CI migration job），没有快照时自动跳过（本地已迁移环境）。

#### CI Workflow（实际实现）

Migration 测试与常规单元测试在**同一个 `unit-test` job** 中完成，通过条件步骤区分两条路径：

```
检测：git diff origin/$GITHUB_BASE_REF HEAD --diff-filter=A -- 'db/add-*.sql' 'db/migrate-*.sql'

┌────────────────────────────────────────────────────────────────────────────┐
│                        CI: unit-test job                                   │
│                                                                            │
│  ① 检测 PR 是否含新 migration 文件                                           │
│                                                                            │
│  ┌─ MIGRATION PATH (has_migrations = true) ────────────────────────────┐  │
│  │  ② Apply BASE branch schema.sql（旧结构）                             │  │
│  │  ③ Download ci.sql；                                                  │  │
│  │     验证 schema-hash == sha256(base schema.sql)                      │  │
│  │  ④ Import seed 到 test DB                                            │  │
│  │  ⑤ npm run test:migration                                            │  │
│  │     beforeAll: 快照旧 FK 值 → 执行 migration SQL                      │  │
│  │     schema verification / integrity verification                    │  │
│  │     invariance verification ← 最关键                                 │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  ┌─ NORMAL PATH (has_migrations = false) ──────────────────────────────┐  │
│  │  ② Apply CURRENT schema.sql                                          │  │
│  │  ③ Download ci.sql；                                                  │  │
│  │     验证 schema-hash == sha256(current schema.sql)                   │  │
│  │  ④ Import seed 到 test DB                                            │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  ⑥ npm test（两条路径都跑）                                                  │
│                                                                            │
│  ⑦ [仅 MIGRATION PATH] 所有测试全部通过后：                                  │
│     npm run seed:schema                 ← 更新 fingerprint               │
│     npm run seed:ci-export -- "演出A"…  ← 上传新 ci.sql                  │
│     新 ci.sql 的 schema-hash = sha256(current schema.sql)                │
└────────────────────────────────────────────────────────────────────────────┘
```

命令：
```bash
# Migration 专用测试（migration.test.ts 自己执行 snapshot + SQL + verify）
npm run test:migration          # → vitest.migration.config.ts

# 常规单元测试（已迁移 DB，global-setup.ts 跳过 migration）
npm test
```

#### 旧 Seed 不需要手动导出

R2 中只有一份 `seed-data/ci.sql`，它始终代表 **main 分支当前的 schema 状态**。其 `-- schema-hash:` 头即为此份 seed 对应的 schema 版本。

Migration PR 被测试时：
- CI 检测到 migration 文件 → 与 **base branch** schema hash 比对（而非当前分支）
- 现有 `ci.sql` 是 base schema 导出的，hash 自然匹配，无需额外准备
- 测试全部通过后，CI 自动上传新的 `ci.sql`（含新 schema hash）

因此，**开发者在发 migration PR 前不需要手动预导出旧 seed**。

#### 本地开发说明

本地 DB 已迁移后，`tests/migration.test.ts` 无法运行 invariance 测试（快照从未生成）。这是预期行为。本地只运行 schema + integrity 验证，完整 invariance 测试依赖 CI 在旧 seed 上执行。

如需本地重新验证 invariance，需在全新的本地 DB 上从头安装当前 R2 `ci.sql`（与 main 同步），再运行 `npm run test:migration`。

### 10.8 CI Seed 管理规约

#### Seed 的本质

`seed-data/ci.sql`（存储于 Cloudflare R2）是**唯一的 CI 种子数据库**。它表示 main 分支某个 schema 版本下的匿名演示数据，所有测试都基于它运行。

文件头部包含一行：
```sql
-- schema-hash: <sha256 of db/schema.sql>
```

CI 用此 hash 验证 seed 与当前被测 schema 是否一致（migration path 对比 base schema hash，normal path 对比当前 schema hash）。Hash 不匹配 → CI 报错，要求重新导出。

#### 脱敏规则（两遍）

Seed 导出由 `npm run seed:ci-export` 调用 `scripts/export-seed.ts` 完成，必须满足：

| 数据类型 | 处理方式 |
|---------|---------|
| `feishu_user.open_id`（`ou_xxx` 格式） | 替换为 `seed-user-N`（pass-1） |
| JSONB 字段中 `"openId": "<名字>"` 的值 | 替换为 `seed-user-N`（pass-2） |
| `feishu_user.name`（显示名） | 替换为 `演示用户N`（不是 ID，不影响引用） |
| 其他业务数据（剧本、场景、台词等） | 保留原样（无个人隐私） |

> **为什么需要 pass-2**：飞书 mention 的 `openId` 字段有时存储的是显示名（而非真实 open_id），pass-1 只匹配 `ou_xxx` 格式会遗漏这种情况，导致 JSONB 里残留真实人名。pass-2 用 `nameToFakeId` map 补全。

**禁止**在没有 pass-2 的情况下导出包含 JSONB mentions 数据的 seed。

#### 何时必须重新导出

| 场景 | 是否需要重新导出 | 命令 |
|------|--------------|------|
| 新增 migration 文件（PR 合并后） | **是**（CI 自动处理） | 无需手动 |
| 修改 `db/schema.sql` 但无 migration | **是**（schema hash 变了） | `npm run seed:ci-export` |
| 添加新演出数据（业务数据变化） | **是** | `npm run seed:ci-export -- "演出A" "演出B"` |
| 纯代码变更（无 schema/数据变化） | 否 | — |

#### Migration PR 导出时的 Schema Swap

Migration PR 分支的 `db/schema.sql` 已是迁移后的新结构，但 R2 上的旧 seed 对应的是 base schema。CI 自动处理这个差异（见 §10.7 schema-hash 对比逻辑），**不需要开发者手动操作**。

仅在需要本地修复旧 seed 内容（例如修正脱敏遗漏）时，才需要 schema swap 技巧：

```bash
# 临时恢复 base schema
git show origin/main:db/schema.sql > /tmp/schema-backup.sql
cp /tmp/schema-backup.sql db/schema.sql

# 在已连接生产 DB 或包含旧结构数据的本地 DB 上导出
npm run seed:ci-export -- "我们的星星" "供养2.0"

# 恢复当前分支的 schema
git checkout -- db/schema.sql
```

#### 上传时机规则

**严禁在所有测试通过之前上传 seed**。如果 migration 测试通过但 unit tests 失败，此时的 DB 状态是迁移后但验证不完整的，上传这份 seed 会导致后续所有 PR 的 CI hash 校验失败。

CI 实现中，`Upload post-migration CI seed` 步骤紧跟在 `Run unit tests` 之后，且仅在 `npm test` 成功的前提下执行（GitHub Actions 默认行为：前序步骤失败则跳过）。

#### CD 是 Seed 的权威来源

CD pipeline（`deploy.yml`）在编译之前也会完整执行一遍 migration 测试流程，并上传新 seed。**这一步是解决"并发 PR 种子竞态"问题的关键**：

- PR A 和 PR B 都含 migration，各自通过了 CI（基于不同时间点的旧 seed）
- A 先合并到 main，CD 上传了 A 的新 seed
- B 后合并，CD 基于最新 main（含 A 的 schema）重新验证并上传 B 的新 seed
- 最终 seed 始终是 main 当前状态下的 CD 验证结果，不会有遗漏

### 10.9 Migration PR 完整检查清单

提交 migration PR 前，逐项确认：

#### 文件层面

- [ ] `db/migrate-<name>.sql`：完整的 migration SQL，包含回滚说明注释
- [ ] `db/schema.sql`：更新为迁移后的最终状态（完整快照）
- [ ] `db/seed-schema.json`：在干净 DB 上重新生成（`npm run seed:schema`）
- [ ] `tests/<name>.migration.test.ts`：包含三层测试（schema / integrity / invariance）
- [ ] `vitest.migration.config.ts` 或等效配置：确保 `npm run test:migration` 能找到测试文件

#### 测试层面

- [ ] `npm run test:migration` 本地通过（至少 schema + integrity 层，invariance 需旧 seed 环境）
- [ ] `npm test` 本地通过（unit tests）
- [ ] 对 seed 数据中 count 类断言（`toBeGreaterThanOrEqual(N)`）进行确认：threshold 与新 seed 数据量匹配

#### 不可做的事

- ❌ **不要在 `.github/workflows/ci.yml` 里硬编码 migration SQL**：CI 通过 `npm run test:migration` 调用测试文件，所有 migration 逻辑属于测试文件，不属于 workflow
- ❌ **不要在测试通过之前手动上传 seed**：CI 自动处理，手动上传可能带入损坏状态
- ❌ **不要在 migration path 下上传时使用当前分支的 schema.sql 计算旧 hash**：需通过 `git show origin/$GITHUB_BASE_REF:db/schema.sql` 获取 base schema
- ❌ **不要跳过 invariance 测试**：`it.skipIf(!snapshot)` 是正确模式，不要将 invariance 测试改为无条件 skip 或 todo
- ❌ **不要将新 migration 文件修改已有 migration 文件**：每个 migration 文件一旦 commit 不可实质修改（见"Migration 文件的修改规则"）
