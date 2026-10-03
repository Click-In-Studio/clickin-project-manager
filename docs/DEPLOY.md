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
```

#### 退役 Agent 库（老机器一次性）

OpenClaw 时代的 `click_in_agent` 库与 `agent_user` 角色已退役（#367 / #603）。migration `retire_agent_user_role` 会回收 `agent_user` 在主库上的全部授权，但它跑在 `script_editor` 里够不着 `click_in_agent` 库内的表级 ACL，于是 `DROP ROLE` 会以 WARNING 跳过。2026-09 之后建的新机器没有这两样东西，跳过本节；老机器 CD 日志见到 `#603: agent_user 在其他库仍有依赖` 后，手动收尾一次：

```bash
sudo -u postgres psql -c "DROP DATABASE IF EXISTS click_in_agent" -c "DROP ROLE IF EXISTS agent_user"
```

新机器不再需要建 Agent 库。

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

如果 pm2 进程尚未存在，CI 会在 `Activate release` 步骤里启动；若已存在且没有 pending migration，则滚动切换。首次部署后执行：

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

**压缩不在这一层**（#641 排查结论）：两机 `nginx.conf` 虽是 `gzip on`，但 `gzip_types`
整段注释着，默认只压 `text/html`——实际把 JSON 与 JS 压掉的是 Next 自己的
`compress: true`（`.next/required-server-files.json` 里可查），nginx 只是透传。
实测 `/login` 与 `/_next/static/chunks/*.js` 出口都带 `content-encoding: gzip`，
静态 chunk 另带 `max-age=31536000, immutable`。所以**排性能时不必先怀疑压缩，
也不需要在 nginx 加 `gzip_types`**：加了只会让同一份响应白压两遍。

验证的办法（在服务器上，绕过与经过 nginx 各一次）：

```bash
curl -s -o /dev/null -D - -H "Accept-Encoding: gzip" http://127.0.0.1:3001/login | grep -i content-encoding
curl -sk -o /dev/null -D - -H "Accept-Encoding: gzip" -H "Host: app.<your-domain>" https://127.0.0.1/login | grep -i content-encoding
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

hotfix：从被修的 tag 拉分支（**不从 main**——main 领先 tag 一大截），修复并先补 `content/changelog/<新 tag>/`，在该 commit 打 `<被修 tag>-hot<n>` 发 prod，再 PR 回 main（migration 按版本号逐支判断 pending，hotfix 分支上时间戳更早的也能正常上）。两台机 nginx 站点块都要有 `proxy_set_header X-Forwarded-Proto $scheme;`（应用侧对非回环 host 一律按 https，不信这个头，#591）。

dev 与 prod 互不阻塞、同一环境串行（workflow `concurrency`）。

## 日常发版

push 到 `main`（dev）或 tag（prod）后 GitHub Actions 自动完成。tag 发布先在 tag 指向的精确 SHA 上运行 changelog、typecheck、lint、schema / migration、全量测试与直跑脚本门禁；全部通过后才进入以下步骤，失败不会读取生产 secrets、SSH、上传或迁移：

1. `npm ci` + `npm run build`（standalone 模式）
2. 打包产物，上传到服务器 `releases/<run>-<sha>/`
3. 只读检查 pending；有 pending 时先停止 Web、Agent runner、heavy worker，再 `pg_dump` 到 `shared/backups/`
4. `dbmate up` 应用所有 pending，随后对账并校验 `script_editor` ACL，再核对线上结构指纹；任一不等都保持停机，禁止旧代码在新 schema 上继续写
5. 切换 `current` symlink → 新 release，启动三个进程并探测 `3001/login`、`3102/health`、`3103/health`
6. 三个入口全部健康后清理旧 releases（保留最新 5 个）

**无需任何手动操作**。

健康检查失败会停止三个进程，即使本次是没有 migration 的纯代码发布也不会让未通过检查的版本继续对外服务。纯代码发布可以按下节切回上一 release；含 migration 的发布保持停机并按数据库状态前向修复或恢复备份。

tag validation 失败但 deploy job 从未开始时，可以显式删除本地与远端失败 tag，修正后在新 commit 上重建同名 tag；deploy 一旦开始，该 tag 就是发布审计记录，不得移动，后续修复必须创建新的 hotfix tag。

## 回滚

```bash
ssh <server> "bash /var/www/production-manager/shared/scripts/rollback.sh"
# 回滚两个版本：
ssh <server> "bash /var/www/production-manager/shared/scripts/rollback.sh 2"
```

脚本只切 `current` symlink，不切数据库。它仅适用于没有 schema 变化的纯代码发布，或者已经逐项证明旧代码对当前 schema 与当前数据具备双向业务语义兼容的发布；“旧 SQL 不报错”不构成兼容证明。

含 migration 的发布默认不做代码软链回滚。migration 一旦开始，失败时保持停机：先用 `schema_migrations` 核对哪些文件已经提交，再前向修复。确需回到发布前状态时使用 CD 自动创建的备份；这会回退发布后的全部数据库写入，所以服务恢复前必须保持停止并明确核对恢复点：

```bash
# 核对已提交到哪支 migration
ssh <server> "cd /var/www/production-manager/current && sudo -u postgres ./bin/dbmate --url 'postgres:///script_editor?host=/var/run/postgresql&sslmode=disable' --migrations-dir db/migrations --no-dump-schema status"
# 需要整体恢复时使用发布前备份
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
