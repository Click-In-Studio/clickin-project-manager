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
- [部署流程](docs/DEPLOY.md) — 服务器部署与数据库迁移说明

## 快速开始（本地开发）

```bash
npm install
cp .env.example .env.local   # 填写飞书、R2、DB 等环境变量
npm run dev
```

详细说明见 [开发指南](docs/DEV_GUIDE.md)。
