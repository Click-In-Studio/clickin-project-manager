# Agent Bot — Architecture Rules

**Read this before writing any code inside `/agent/` or modifying `app/api/feishu-webhook/`.**

## Folder structure

```
/agent/
  index.ts   — entry point; exports processMessage(ctx)
  db.ts      — all DB queries the agent needs
  types.ts   — BotContext and all shared agent types
```

## Isolation rules

1. `/agent/` may only import from **`lib/roles.ts`** outside its own folder.  
   Everything else in `lib/` — including `lib/db.ts`, `lib/event-db.ts`, `lib/feishu-bot.ts`, `lib/notify.ts`, `lib/feishu-auth.ts`, etc. — is **off-limits**.

2. **Database access**: use `agent/db.ts` exclusively. Do not import from any `lib/*` DB module.  
   If you need data that another lib module already queries (members, productions, events, schedules, permissions), write your own typed query in `agent/db.ts`.

3. **No Next.js APIs** inside `/agent/`. No `cookies()`, `NextRequest`, `headers()`, etc.  
   Keep `/agent/` pure TypeScript / Node.js so it stays testable and portable.

4. The **only** file that may import from `/agent/` is `app/api/feishu-webhook/route.ts`.

## Data flow

```
Feishu → POST /api/feishu-webhook
           │
           ├─ challenge echo (inline, no agent involvement)
           ├─ tester gate check (lib/feishu-webhook.ts — allowed exception)
           ├─ build BotContext (inline in webhook route)
           └─ processMessage(ctx)  ← agent/index.ts
```

## Entry point contract

```typescript
// agent/index.ts
import type { BotContext } from "./types";
export async function processMessage(ctx: BotContext): Promise<void>
```

## Agent database

The agent uses a **separate PostgreSQL database** (`click_in_agent`), fully independent from `script_editor`:
- Different DB name, different user (`agent_user`), different password.
- All agent tables must be created in `click_in_agent` only — never in `script_editor`.
- Setup script: `db/setup-agent-db.sql` (run once as postgres superuser).
- Required `.env.local` keys: `AGENT_PGDATABASE`, `AGENT_PGHOST`, `AGENT_PGUSER`, `AGENT_PGPASSWORD`.

## agent/db.ts contract

- Gets `Pool` from `pg` directly using `AGENT_PG*` env vars (NOT the shared `PGUSER`/`PGPASSWORD`).
- Re-export a `getPool()` that reuses a module-level singleton.
- All functions are async, typed, and return plain objects — no ORM.

## Deploy workflow

因为 webhook 只能在线上测试，每次 agent_bot 开发结束、类型和结构确认之后，必须部署一次服务器才能实际测试。

```bash
rsync -a --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='.env.local' \
  ./ click-in:/var/www/production-manager/
ssh click-in "cd /var/www/production-manager && npm run build && pm2 restart production-manager --update-env"
```

## LLM interface

`agent/llm.ts` exports `chat(messages, options?)`. Currently OpenAI-compatible.
- API key: `OPENAI_API_KEY` env var.
- Default model: `OPENAI_MODEL` env var (falls back to `gpt-4o-mini`).
- To swap providers: add a new driver in `llm.ts` and update `chat()`.

## Prompt templates

- Template engine: `agent/prompt.ts` — `render(template, vars)` and `buildMessages(templates, vars)`.
- Placeholder syntax: `{{variableName}}`. Unresolved vars are left as-is and logged.
- All prompt templates live in `agent/prompts/`. Base system prompt: `agent/prompts/_base.ts`.
- Never build prompts via string concatenation — always use `buildMessages()`.

## Permission checks

- Import role constants and `hasPermission()` from `lib/roles.ts` only.  
- To check a user's roles/overrides, query the DB directly in `agent/db.ts`.
