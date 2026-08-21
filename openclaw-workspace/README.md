# openclaw-workspace/ — 团队 gateway 的 workspace 文件（版本控制源）

服务器上 OpenClaw 团队实例的 workspace（`/home/openclaw/.openclaw/workspace-team/`）
以本目录为**唯一事实来源**，CD 在内容变更时自动同步（见 `.github/workflows/deploy.yml`）。

- **不要在服务器上直接改这些文件**——下次内容变更的部署会覆盖。改行为规范走 PR。
- `AGENTS.md` 是**系统级指令**（agents.md 三级注入的最高层，设计见 MindWeave
  《Agents.md 分级注入设计》）：刻意不做在线编辑，死命令进版本控制才安全。
  制作级/个人级指令在 DB（`agent_instructions` 表），经 `/inject-context` 注入。
- 其余文件（SOUL/IDENTITY/TOOLS/HEARTBEAT/USER）是 OpenClaw 的 workspace 惯例
  文件，按纳管时的线上现状入库；`USER.md` 是上游默认模板，其"单用户"假设与
  团队 gateway 的多用户会话并不匹配——留待人格定制工程处理，勿据它写入个人信息。
- `openclaw-workspace-state.json` 是运行时状态，**不纳管、不同步、不覆盖**。
