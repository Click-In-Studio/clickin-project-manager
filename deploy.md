# 部署说明

## 服务器信息

| 项目 | 值 |
|------|-----|
| SSH host | `click-in`（~/.ssh/config，IP REDACTED，user ubuntu，key Mac.pem） |
| 部署路径 | `/var/www/production-manager` |
| pm2 进程名 | `production-manager` |
| 数据库 | PostgreSQL，DB `script_editor`，PG user `script_editor` |

## 部署流程

```bash
# 同步代码（绝不覆盖 .env.local）
rsync -av --exclude='.env.local' --exclude='node_modules' --exclude='.next' \
  ./ click-in:/var/www/production-manager/

# 在服务器上 build & restart
ssh click-in "cd /var/www/production-manager && npm install && npm run build && pm2 restart production-manager --update-env"
```

## 数据库迁移

```bash
ssh click-in "sudo -u postgres psql -d script_editor -f /var/www/production-manager/db/migrate-XXX.sql"
```

所有迁移文件均已在服务器执行完毕。`notification_job` 表已废弃并已 DROP。

## 时区约定

**全系统时区基准：UTC+8（中国标准时间，CST）**

- 数据库存储：所有时间字段使用 `TIMESTAMPTZ`，存为 UTC
- 显示层：所有面向用户的时间均转换为 UTC+8 再展示
- 代码惯例：服务端日期运算通过 `+8 * 3_600_000ms` 手动偏移，不依赖系统时区

## 通知 Cron（在服务器 crontab 配置）

所有时间为 CST（UTC+8）。因服务器在 UTC，crontab 时间需减 8 小时。

```cron
# 每周日 12:00 CST（= 04:00 UTC）— 发送 weekly call 通知
0 4 * * 0  curl -sX POST https://www.clickinmusical.com/app/api/internal/notify/weekly-call \
             -H "Authorization: Bearer $INTERNAL_NOTIFY_SECRET" >> /var/log/notify-weekly.log 2>&1

# 每天 12:00 CST（= 04:00 UTC）— 发送 D+1 的 daily call 通知
0 4 * * *  curl -sX POST https://www.clickinmusical.com/app/api/internal/notify/daily-call \
             -H "Authorization: Bearer $INTERNAL_NOTIFY_SECRET" >> /var/log/notify-daily.log 2>&1
```

`$INTERNAL_NOTIFY_SECRET` 与 `.env.local` 中的值一致。

## 必须配置的环境变量（.env.local）

```
# 已有
FEISHU_APP_ID=...
FEISHU_REDIRECT_URI=...

# 新增
FEISHU_APP_SECRET=...          # 飞书应用 secret，用于 bot 发消息
APP_BASE_URL=https://...       # 应用外部访问地址，用于卡片链接（不含末尾斜杠）
INTERNAL_NOTIFY_SECRET=...     # cron 调用内部通知接口的鉴权 token
```
