# 部署流程

服务器的具体信息（IP、路径、凭据等）存放在 `docs/DEPLOY_LOCAL.md`（gitignored，不进仓库）。

## 标准部署

```bash
# 1. 同步代码到服务器（不覆盖 .env.local）
rsync -a --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='.env.local' \
  ./ <server>:/var/www/production-manager/

# 2. 在服务器上 build 并重启
ssh <server> "cd /var/www/production-manager && npm install && npm run build && pm2 restart production-manager --update-env"
```

如果新增了 npm 依赖，`npm install` 会安装；否则跳过也可以（build 会报错提示）。

## 数据库迁移

每次发版如有 schema 变更，在部署前执行：

```bash
ssh <server> "sudo -u postgres psql -d script_editor -f /var/www/production-manager/db/migrate-xxx.sql"
```

迁移文件在 `db/migrate-*.sql`，按需执行，不重复执行。

## 时区约定

- 数据库：所有时间字段 `TIMESTAMPTZ`，存储 UTC。
- 用户界面：展示时转为 UTC+8（CST）。
- Cron job 时间：服务器在 UTC，crontab 时间需减 8 小时。

## Cron 通知

在服务器 crontab 中配置（时间均为 UTC）：

```cron
# 每天 12:00 CST = 04:00 UTC：发送次日 daily call 通知
0 4 * * *  curl -sX POST https://<host>/app/api/internal/notify/daily-call \
             -H "Authorization: Bearer $INTERNAL_NOTIFY_SECRET" >> /var/log/notify-daily.log 2>&1

# 每周日 12:00 CST = 04:00 UTC：发送当周 weekly call 通知
0 4 * * 0  curl -sX POST https://<host>/app/api/internal/notify/weekly-call \
             -H "Authorization: Bearer $INTERNAL_NOTIFY_SECRET" >> /var/log/notify-weekly.log 2>&1
```

## 环境变量（.env.local）

服务器上的 `.env.local` 需包含：

```
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_REDIRECT_URI=
FEISHU_WEBHOOK_TOKEN=
FEISHU_ENCRYPT_KEY=

PGHOST=
PGDATABASE=script_editor
PGUSER=script_editor
PGPASSWORD=

AGENT_PGHOST=
AGENT_PGDATABASE=click_in_agent
AGENT_PGUSER=agent_user
AGENT_PGPASSWORD=

R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=click-in

APP_BASE_URL=https://<your-domain>
INTERNAL_NOTIFY_SECRET=

OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
```
