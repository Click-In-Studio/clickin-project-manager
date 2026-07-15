# Click-In Production Manager

演出制作管理平台——供剧组内部使用，涵盖剧本版本管理、排练日程、Cue List、资产文件等模块。

## 技术栈

- **框架**：Next.js 16 App Router（TypeScript）
- **数据库**：PostgreSQL
- **文件存储**：Cloudflare R2
- **身份验证**：飞书 OAuth
- **Bot**：飞书群机器人（OpenAI-compatible LLM）

## 文档

- [使用指南](docs/USER_GUIDE.md) — 各功能的操作说明与注意事项
- [开发指南](docs/DEV_GUIDE.md) — 项目结构、本地开发、新增功能流程
- [部署流程](docs/DEPLOY.md) — 首次部署与日常发版说明

---

## 本地开发快速开始

### 1. PostgreSQL

```bash
# 创建主库用户和数据库
sudo -u postgres psql <<'EOF'
CREATE USER script_editor WITH PASSWORD 'your-password';
CREATE DATABASE script_editor OWNER script_editor;
EOF

# 初始化 schema
sudo -u postgres psql -d script_editor -f db/schema.sql

# 创建 Agent Bot 数据库（可选，仅 Bot 功能需要）
sudo -u postgres psql -f db/setup-agent-db.sql
```

### 2. 飞书应用

在[飞书开放平台](https://open.feishu.cn)创建**自建应用（内部应用）**：

1. **添加应用能力** → 开启「机器人」
2. **安全设置** → 添加 OAuth 重定向 URL：
   ```
   http://127.0.0.1:3000/app/api/oath-callback
   ```
3. **权限管理** → 申请以下权限（标注 `*Bot` 的仅在启用群机器人功能时需要）：
   - `contact:user.base:readonly`（读取用户信息）
   - `contact:user.id:readonly`
   - `im:message:send_as_bot` \*Bot（Bot 发消息）
   - `im:message` \*Bot（接收群消息）
4. \*Bot：**事件与回调 → 事件订阅** → 添加事件 `im.message.receive_v1`，填写回调 URL（`/app/api/feishu-webhook`）
5. 发布/更新应用版本，在企业内开放

获取 **App ID** 和 **App Secret** 填入 `.env.local`。

### 3. Cloudflare R2

1. 在 Cloudflare Dashboard 创建 Bucket（本地用独立测试 bucket，如 `click-in-test`）
2. 创建 API Token（权限：Object Read & Write），获取 Account ID、Access Key ID、Secret Access Key
3. 配置 Bucket **CORS**（Cloudflare Dashboard → R2 → Bucket → Settings → CORS）：

```json
[{
  "AllowedOrigins": ["http://127.0.0.1:3000"],
  "AllowedMethods": ["GET", "PUT"],
  "AllowedHeaders": ["*"],
  "MaxAgeSeconds": 3600
}]
```

### 4. 环境变量

新建 `.env.local`，按以下分组填写：

```bash
# ── 核心（必填）──────────────────────────────────────────────────────────────
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=xxxxxxxx
FEISHU_REDIRECT_URI=http://127.0.0.1:3000/app/api/oath-callback

PGHOST=localhost
PGDATABASE=script_editor
PGUSER=script_editor
PGPASSWORD=your-password

SESSION_SECRET=any-random-string        # 生产环境必须设置；本地开发可留空（有警告）

# ── 文件上传（使用资产/文件功能时必填）──────────────────────────────────────
R2_ACCOUNT_ID=xxxxxxxx
R2_ACCESS_KEY_ID=xxxxxxxx
R2_SECRET_ACCESS_KEY=xxxxxxxx
R2_BUCKET=click-in-test                 # 本地建议用独立测试 bucket

# ── 群机器人 / 定时通知（启用 Bot 功能时必填）──────────────────────────────
AGENT_PGHOST=localhost
AGENT_PGDATABASE=click_in_agent
AGENT_PGUSER=agent_user
AGENT_PGPASSWORD=your-agent-password

LLM_PROVIDER=openai                     # openai（默认）或 deepseek
OPENAI_API_KEY=sk-xxxxxxxx
# OPENAI_MODEL=gpt-4o-mini             # 可选，默认 gpt-4o-mini
# DEEPSEEK_API_KEY=sk-xxxxxxxx         # 使用 DeepSeek 时设置，替代 OPENAI_API_KEY
# DEEPSEEK_MODEL=deepseek-chat         # 可选，默认 deepseek-chat

INTERNAL_NOTIFY_SECRET=any-local-secret # 定时通知 cron 鉴权 Bearer token
```

### 5. 启动

```bash
npm install
npm run dev
```

访问 `http://127.0.0.1:3000/app`。

> **注意**：飞书 OAuth 回调必须用 `127.0.0.1`，不能用 `localhost`，两者在飞书侧被视为不同域名。

### 6. 加载测试数据（可选）

本地库初始化后为空库。可一键加载包含真实剧本和 Cue 数据的演示数据供测试使用：

```bash
npm run seed:demo
```

该命令从公开 R2 URL 下载 SQL 文件并导入本地库。**不需要 R2 凭据**，只需 DB 连接正常即可。导入后会新增两个演出：
- **供养2.0** — 包含完整剧本与 dramaturgy 数据
- **我们的星星** — 包含版本管理与 Cue List 数据

> 重复执行是安全的：命令会先删除这两个演出再重新导入，不影响其他本地数据。

**（维护者）更新 seed 数据：**

```bash
npm run seed:export -- "供养2.0" "我们的星星"
```

需要在 `.env.local` 中额外配置：

```
SEED_R2_BUCKET=click-in-public   # 公有 R2 bucket 名称
```
