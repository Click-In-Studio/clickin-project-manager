# 部署流程

服务器的具体信息（IP、SSH host、凭据等）存放在 `docs/DEPLOY_LOCAL.md`（gitignored，不进仓库）。

---

## 首次部署

### 1. 服务器环境

> 2026-09 新机器（阿里云 `click-in-2`，Ubuntu 24.04）就是按本节 + 下面各节从零装起来的，
> 差异只有：部署用户是 `admin` 不是 `ubuntu`（需 NOPASSWD sudo）；node 装在 `/opt/node`（官方
> tarball，`/usr/local/bin/{node,npm,npx,pm2}` 软链）；`pm2 startup systemd -u <user>`；加了 1G swap
> （`vm.swappiness=10`）；时区设成 UTC 与 crontab 的 UTC 写法对齐。

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
# 主库：角色 + 默认权限（幂等），再由 dbmate 从 baseline 建到最新。
# 表 owner 必须是 postgres，应用用户 script_editor 只拿 DML（见 DEV_GUIDE §6）。
cd /var/www/production-manager/current
sudo -u postgres psql -v app_password='your-password' -f db/bootstrap-roles.sql
sudo -u postgres ./bin/dbmate --url 'postgres:///script_editor?host=/var/run/postgresql&sslmode=disable' \
  --migrations-dir db/migrations --no-dump-schema up

# Agent Bot 数据库
sudo -u postgres psql -f /var/www/production-manager/db/setup-agent-db.sql
```

### 3. 飞书应用配置

在[飞书开放平台](https://open.feishu.cn)创建**自建应用（内部应用）**：

1. **添加应用能力** → 开启「机器人」
2. **安全设置** → 重定向 URL 添加（每个托管子域各一条）：
   ```
   https://app.<your-domain>/api/oath-callback
   https://backstage.<your-domain>/api/oath-callback
   ```
   redirect_uri 由服务器根据请求的 Host 头动态构造，无需在 env 里写死。
3. **权限管理** → 申请以下权限：
   - `contact:user.base:readonly`（读取用户基本信息，登录时获取姓名、头像）
   - `contact:user.id:readonly`（获取 open_id）
   - `im:message:send_as_bot`（Bot 主动推送消息）
   - `im:message`（接收群消息，供 Bot 使用）
4. **事件与回调**：群消息 bot 已退役（2026-08），不需要再配置事件订阅；`/api/feishu-webhook` 已删除。
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
  "AllowedOrigins": ["https://app.<your-domain>", "https://backstage.<your-domain>"],
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
# FEISHU_REDIRECT_URI 已不再需要——redirect_uri 由服务器从 Host 头动态构造
FEISHU_WEBHOOK_TOKEN=xxxxxxxx
FEISHU_ENCRYPT_KEY=xxxxxxxx

PGHOST=localhost
PGDATABASE=script_editor
PGUSER=script_editor
PGPASSWORD=xxxxxxxx
# 连接池四道闸的缺省值在 lib/pg.ts；**池大小按进程分配**，写在
# deploy/ecosystem.config.js 的进程 env 里（这份 .env.local 三个进程共用，区分不了）

R2_ACCOUNT_ID=xxxxxxxx
R2_ACCESS_KEY_ID=xxxxxxxx
R2_SECRET_ACCESS_KEY=xxxxxxxx
R2_BUCKET=click-in

APP_BASE_URL=https://app.<your-domain>
INTERNAL_NOTIFY_SECRET=xxxxxxxx   # 随机字符串，用于保护 cron 接口

OPENAI_API_KEY=sk-xxxxxxxx
OPENAI_MODEL=gpt-4o-mini

# MMP 多模态感知服务（#453 / #454：OCR 等由自建 broker 承接）。不设 = AI 的 OCR 工具
# 诚实报「服务不可用」，其余功能不受影响。key 是 broker 的 api_key，不进仓库。
MMP_BASE_URL=https://mmp.<your-domain>
MMP_API_KEY=xxxxxxxx

# 后台重活队列（lib/job/queue.ts）：设 1 表示由 heavy-worker 进程消费任务
# （pdf/docx 解析、缩略图等）。不设则 enqueue 方原地执行——dev/未部署 worker 的
# 环境用；生产必设，否则重活又回到 next / agent-runner 进程里跑。
JOB_WORKER=1
```

### 6. 触发首次部署

服务器环境配置完成后，push 到 `main` 即触发 CI/CD（`deploy.yml`）自动完成首次部署：构建、打包上传、应用 DB schema、创建 release 目录、启动 pm2。

如果 pm2 进程尚未存在，CI 会在 `Activate release` 步骤里执行 `pm2 start`；若已存在则 `pm2 reload`。首次部署后执行：

```bash
ssh <server> "pm2 save"   # 持久化进程列表，开机自启
```

### 7. Nginx 反向代理

应用通过子域名访问，无 basePath 前缀。将下面的配置写入 sites-available 并 symlink 到 sites-enabled，然后 `sudo nginx -t && sudo systemctl reload nginx`。

```nginx
# app.<your-domain> → production-manager (port 3001)
server {
    listen 443 ssl;
    # HTTP/2（#467）：不开的话浏览器对同源只给 6 条并发 HTTP/1.1 连接，而协作 SSE
    # 是常驻长连接——剧本 + Cue + 几篇 wiki + AI 侧栏同开就顶满，此后所有同源请求
    # 排队、整页静默卡死。HTTP/2 单连接多路复用，并发上限抬到
    # http2_max_concurrent_streams（默认 128）。nginx < 1.25.1 没有这条指令，
    # 改写成 `listen 443 ssl http2;`。
    http2 on;
    server_name app.<your-domain>;
    ssl_certificate /etc/letsencrypt/live/app.<your-domain>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.<your-domain>/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        client_max_body_size 32m;
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        # SSE 长连接（#465）：默认 proxy_read_timeout 60s 会掐断空闲流。
        # 应用侧已有 25s keepalive 注释帧治本，这里放宽是防降级场景；
        # 反代 buffering 由各 SSE 响应的 X-Accel-Buffering: no 逐响应关闭，
        # 不需要全局 proxy_buffering off。
        proxy_read_timeout 3600s;
    }
}
server {
    listen 80;
    server_name app.<your-domain>;
    return 301 https://app.<your-domain>$request_uri;
}

# backstage.<your-domain> → production-manager (port 3001，与 app 共用同一服务)
server {
    listen 443 ssl;
    http2 on;                       # 同 app：SSE 撑不爆同源连接池（#467）
    server_name backstage.<your-domain>;
    ssl_certificate /etc/letsencrypt/live/app.<your-domain>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.<your-domain>/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        client_max_body_size 32m;
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 3600s;   # 同 app：SSE 空闲不掐断（#465）
    }
}
server {
    listen 80;
    server_name backstage.<your-domain>;
    return 301 https://backstage.<your-domain>$request_uri;
}
```

SSL 证书申请（两个子域名可共用一张）：

```bash
sudo certbot --nginx -d app.<your-domain> -d backstage.<your-domain>
```

### 8. Cron 通知

```bash
crontab -e
```

添加（时间均为 UTC，CST = UTC+8）：

```cron
# 每天 12:00 CST（04:00 UTC）发送次日 daily call 通知
0 4 * * *  curl -sX POST https://app.<your-domain>/api/internal/notify/daily-call \
             -H "Authorization: Bearer $INTERNAL_NOTIFY_SECRET" >> /var/log/notify-daily.log 2>&1

# 每周日 12:00 CST（04:00 UTC）发送本周 weekly call 通知
0 4 * * 0  curl -sX POST https://app.<your-domain>/api/internal/notify/weekly-call \
             -H "Authorization: Bearer $INTERNAL_NOTIFY_SECRET" >> /var/log/notify-weekly.log 2>&1
```

---

## 两套环境（#558）

| 环境 | 触发 | 机器 | 域名 | 用途 |
|---|---|---|---|---|
| dev | push `main` | 阿里云香港（ssh alias `click-in-dev`） | `app-dev.clickinmusical.com` | 团队日常，跟着 main 走 |
| prod | push tag `v*` | 阿里云香港（ssh alias `click-in-prod`） | `app.clickinmusical.com` / `backstage.clickinmusical.com` | 测试用户，只随 tag 变 |

（AWS 机 `click-in` 已于 2026-09-19 关停；两台阿里云机都是它的整机搬迁。新机恢复库前先装 pgvector，恢复后跑 `db/fingerprint.sql` 对指纹、再扫一遍 `has_table_privilege('script_editor', …)`——指纹看不到 ACL。）

两台机器的目录布局、pm2 定义、迁移流程完全一致，`deploy.yml` 只按 `github.ref_type` 选 SSH 目标（secrets `SERVER_HOST[_PROD]` / `SERVER_USER[_PROD]`，私钥共用）。两边各有自己的库，互不同步；dev 的库是切换时从 prod 拷的快照。

发布到 prod（tag 形态见 DEV_GUIDE §4「版本号」：里程碑 `v0.1.2` / 日常 `v0.1.2-260924` / hotfix `v0.1.2-260924-hot1`）：

```bash
npm run changelog:release -- v0.1.2-260924     # 卷 unreleased/，编辑后 commit
git tag v0.1.2-260924 && git push origin v0.1.2-260924   # 从 main 上已验证的 commit 打 tag
```

hotfix：从被修的 tag 拉分支（**不从 main**——main 领先 tag 一大截），修复后在该 commit 打 `<被修 tag>-hot<n>` 发 prod，再补 `content/changelog/<新 tag>/` 并 PR 回 main（migration 按版本号逐支判断 pending，hotfix 分支上时间戳更早的也能正常上）。两台机 nginx 站点块都要有 `proxy_set_header X-Forwarded-Proto $scheme;`（应用侧对非回环 host 一律按 https，不信这个头，#591）。

dev 与 prod 互不阻塞、同一环境串行（workflow `concurrency`）。

## 日常发版

push 到 `main`（dev）或 tag（prod）后 GitHub Actions 自动完成：

1. `npm ci` + `npm run build`（standalone 模式）
2. 打包产物，上传到服务器 `releases/<run>-<sha>/`
3. `dbmate up` 应用 `db/migrations/` 里所有 pending（记账在库里的 `schema_migrations`；有 pending 先 `pg_dump` 到 `shared/backups/`），随后核对线上结构指纹 == `db/schema-fingerprint.txt`，不等即部署失败
4. 切换 `current` symlink → 新 release
5. `pm2 reload` 热重启
6. 清理旧 releases（保留最新 5 个）

**无需任何手动操作**。

## 回滚

```bash
ssh <server> "bash /var/www/production-manager/shared/scripts/rollback.sh"
# 回滚两个版本：
ssh <server> "bash /var/www/production-manager/shared/scripts/rollback.sh 2"
```

脚本将 `current` symlink 切到上一个（或第 N 个）release，并热重启 PM2。

切代码不切库。这是安全的，因为 migration 遵守 expand / contract（DEV_GUIDE §6）：删列 / 删表永远晚于停用它的代码一个版本，所以上一版代码在当前 schema 上照常跑。真要回退 schema：

```bash
# 只加不删的那支（写了真 migrate:down）：
ssh <server> "cd /var/www/production-manager/current && sudo -u postgres ./bin/dbmate --url 'postgres:///script_editor?host=/var/run/postgresql&sslmode=disable' --migrations-dir db/migrations --no-dump-schema down"
# 破坏性 / 数据迁移：用发布前 CD 自动做的备份
ls -lt /var/www/production-manager/shared/backups/
sudo -u postgres pg_restore -d script_editor --clean --if-exists <备份文件>
```

## 数据库迁移

CD 自动处理（dbmate）。查线上状态：

```bash
ssh <server> "cd /var/www/production-manager/current && sudo -u postgres ./bin/dbmate --url 'postgres:///script_editor?host=/var/run/postgresql&sslmode=disable' --migrations-dir db/migrations --no-dump-schema status"
```

紧急修复也走 migration：`npm run db -- new hotfix_xxx` → 合并 → CD 执行。不要在服务器上手跑 SQL 改结构——线上指纹校验会在下一次发布把手改的差异报成红。

---

## 时区约定

- 数据库：所有时间字段 `TIMESTAMPTZ`，存储 UTC
- 用户界面：展示时统一转为 UTC+8（CST）
- Cron job：服务器在 UTC，crontab 时间需减 8 小时
