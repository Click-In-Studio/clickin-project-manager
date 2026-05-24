# 部署流程

服务器的具体信息（IP、SSH host、凭据等）存放在 `docs/DEPLOY_LOCAL.md`（gitignored，不进仓库）。

---

## 首次部署

### 1. 服务器环境

```bash
# Node.js（建议通过 nvm 安装 LTS 版本）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install --lts && nvm use --lts

# pm2
npm install -g pm2

# PostgreSQL（Ubuntu）
sudo apt install -y postgresql postgresql-contrib
```

### 2. 数据库初始化

```bash
# 主库
sudo -u postgres psql <<'EOF'
CREATE USER script_editor WITH PASSWORD 'your-password';
CREATE DATABASE script_editor OWNER script_editor;
EOF

sudo -u postgres psql -d script_editor -f /var/www/production-manager/db/schema.sql

# Agent Bot 数据库
sudo -u postgres psql -f /var/www/production-manager/db/setup-agent-db.sql
```

### 3. 飞书应用配置

在[飞书开放平台](https://open.feishu.cn)创建**自建应用（内部应用）**：

1. **添加应用能力** → 开启「机器人」
2. **安全设置** → 重定向 URL 添加：
   ```
   https://<your-domain>/app/api/auth/feishu-code
   ```
3. **权限管理** → 申请以下权限：
   - `contact:user.base:readonly`（读取用户基本信息，登录时获取姓名、头像）
   - `contact:user.id:readonly`（获取 open_id）
   - `im:message:send_as_bot`（Bot 主动推送消息）
   - `im:message`（接收群消息，供 Bot 使用）
4. **事件与回调 → 事件订阅**：
   - 请求 URL 填：`https://<your-domain>/app/api/feishu-webhook`
   - 添加事件：`im.message.receive_v1`
   - 记录 **Verification Token** 和 **Encrypt Key**
5. 创建新版本并发布，在企业内对全员开放

### 4. Cloudflare R2 配置

#### 创建 Bucket

在 Cloudflare Dashboard → R2 → Create bucket，建议命名 `click-in`（生产环境）。

#### API Token

Dashboard → R2 → Manage R2 API Tokens → Create API Token：
- 权限：**Object Read & Write**
- 作用范围：指定 bucket 或全部
- 记录 Account ID、Access Key ID、Secret Access Key

#### CORS

Dashboard → R2 → 对应 Bucket → Settings → CORS Policy：

```json
[{
  "AllowedOrigins": ["https://<your-domain>"],
  "AllowedMethods": ["GET", "PUT"],
  "AllowedHeaders": ["*"],
  "MaxAgeSeconds": 3600
}]
```

> **注意**：`GET` 权限是音视频预览（WaveSurfer 跨域 fetch）的必需项；`PUT` 是客户端直传上传的必需项。`AllowedHeaders: ["*"]` 是 PUT 时自定义 Content-Type header 的必需项。

### 5. 配置 .env.local

在服务器 `/var/www/production-manager/.env.local` 写入：

```
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=xxxxxxxx
FEISHU_REDIRECT_URI=https://<your-domain>/app/api/auth/feishu-code
FEISHU_WEBHOOK_TOKEN=xxxxxxxx
FEISHU_ENCRYPT_KEY=xxxxxxxx

PGHOST=localhost
PGDATABASE=script_editor
PGUSER=script_editor
PGPASSWORD=xxxxxxxx

AGENT_PGHOST=localhost
AGENT_PGDATABASE=click_in_agent
AGENT_PGUSER=agent_user
AGENT_PGPASSWORD=xxxxxxxx

R2_ACCOUNT_ID=xxxxxxxx
R2_ACCESS_KEY_ID=xxxxxxxx
R2_SECRET_ACCESS_KEY=xxxxxxxx
R2_BUCKET=click-in

APP_BASE_URL=https://<your-domain>
INTERNAL_NOTIFY_SECRET=xxxxxxxx   # 随机字符串，用于保护 cron 接口

OPENAI_API_KEY=sk-xxxxxxxx
OPENAI_MODEL=gpt-4o-mini
```

### 6. 首次部署代码

```bash
rsync -a --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='.env.local' \
  ./ <server>:/var/www/production-manager/

ssh <server> "cd /var/www/production-manager && npm install && npm run build && pm2 start npm --name production-manager -- start"
pm2 save  # 持久化，开机自启
```

### 7. Nginx 反向代理

```nginx
server {
    listen 443 ssl;
    server_name <your-domain>;

    location /app {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 8. Cron 通知

```bash
crontab -e
```

添加（时间均为 UTC，CST = UTC+8）：

```cron
# 每天 12:00 CST（04:00 UTC）发送次日 daily call 通知
0 4 * * *  curl -sX POST https://<your-domain>/app/api/internal/notify/daily-call \
             -H "Authorization: Bearer $INTERNAL_NOTIFY_SECRET" >> /var/log/notify-daily.log 2>&1

# 每周日 12:00 CST（04:00 UTC）发送本周 weekly call 通知
0 4 * * 0  curl -sX POST https://<your-domain>/app/api/internal/notify/weekly-call \
             -H "Authorization: Bearer $INTERNAL_NOTIFY_SECRET" >> /var/log/notify-weekly.log 2>&1
```

---

## 日常发版

```bash
# 同步代码
rsync -a --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='.env.local' \
  ./ <server>:/var/www/production-manager/

# Build & 重启（npm install 仅在新增依赖时需要）
ssh <server> "cd /var/www/production-manager && npm install && npm run build && pm2 restart production-manager --update-env"
```

## 数据库迁移

每次发版如有 schema 变更，在部署前执行对应迁移文件：

```bash
ssh <server> "sudo -u postgres psql -d script_editor -f /var/www/production-manager/db/migrate-xxx.sql"
```

迁移文件在 `db/migrate-*.sql`，只需执行尚未在服务器上跑过的文件，不重复执行。

---

## 时区约定

- 数据库：所有时间字段 `TIMESTAMPTZ`，存储 UTC
- 用户界面：展示时统一转为 UTC+8（CST）
- Cron job：服务器在 UTC，crontab 时间需减 8 小时
