# openclaw-workspace/ — 团队 gateway 的 workspace 文件（版本控制源）

服务器上 OpenClaw 团队实例的 workspace（`/home/openclaw/.openclaw/workspace-team/`）
以本目录为**唯一事实来源**，CD 在内容变更时自动同步（见 `.github/workflows/deploy.yml`）。

- **不要在服务器上直接改这些文件**——下次内容变更的部署会覆盖。改行为规范走 PR。
- `AGENTS.md` 是**系统级指令**（agents.md 三级注入的最高层，设计见 MindWeave
  《Agents.md 分级注入设计》）：刻意不做在线编辑，死命令进版本控制才安全。
  制作级/个人级指令在 DB（`agent_instructions` 表），经 `/inject-context` 注入。
- 其余文件是 OpenClaw 的 workspace 惯例文件，已按团队场景定制（2026-08-21 拍板）：
  `IDENTITY.md`=「后台助手」🎭；`SOUL.md`=人格基调（专业/简洁/中文恒定回复/
  不戏剧化）；`USER.md` 反向写法——多用户防泄露声明（上游的单用户假设在团队
  gateway 不成立，**任何个人信息不得写入 workspace 文件**）；`TOOLS.md`=本环境
  工具备注（my.*/production.* 语义分界、确认卡与拒绝理由、无主动提问工具）。
  这些文件**每个 run 全量进 prompt**（dist 实测），改动时字字计较。
- `openclaw-workspace-state.json` 是运行时状态，**不纳管、不同步、不覆盖**。
