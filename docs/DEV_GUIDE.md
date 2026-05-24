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
│   ├── production/[id]/    # 剧目子页面（剧本、场景、Cue、Asset 等）
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

### 迁移约定

- 所有结构变更写在 `db/migrate-*.sql` 中，文件名描述变更内容。
- 新建表时，先看 `db/schema.sql` 了解已有结构。
- 每次迁移在服务器上手动执行一次：

```bash
ssh click-in "sudo -u postgres psql -d script_editor -f /var/www/production-manager/db/migrate-xxx.sql"
```

### 两个数据库

| 库 | 用途 | 连接配置 |
|----|------|---------|
| `script_editor` | 主业务数据 | `PG*` 环境变量 |
| `click_in_agent` | Bot 对话、记忆 | `AGENT_PG*` 环境变量 |

两库完全独立，不做跨库 join。

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

1. 在 `db/migrate-xxx.sql` 写 `ALTER TABLE` 或 `CREATE TABLE`。
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
