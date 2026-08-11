// clickin-memory — Click-In 团队 OpenClaw 插件（Phase 4 v1）
//
// 三个 hook（签名已按 2026.7.2-beta.7 shipped .d.ts 核实，见 MindWeave
// 《Plugin Hook API 核实》）：
//   before_prompt_build  按 sessionKey 解析 userId，注入个人记忆摘要
//   agent_end            本轮对话落盘（v1 原始捕获；控制面提炼接口留坑）
//   before_tool_call     非只读 clickin__* 工具挂 requireApproval 确认门
//
// 运行环境是 gateway 主机的 OpenClaw 进程，不是 Next.js —— 本文件不参与
// production-manager 的构建（tsconfig/eslint 均排除），openclaw SDK 的
// import 在 gateway 侧解析。
//
// 部署：openclaw plugins install --link <repo>/openclaw-plugins/clickin-memory
// 并在 openclaw.json 配 plugins.entries.clickin-memory.hooks.allowConversationAccess: true

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
// @ts-expect-error 仅在 gateway 运行时可解析
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

type PluginConfig = {
  mcpUrl?: string;
  memoryDir?: string;
  injectMaxChars?: number;
  recentDays?: number;
  recentMaxEntries?: number;
  recentMaxChars?: number;
  approvalEnabled?: boolean;
};

const DEFAULTS: Required<PluginConfig> = {
  mcpUrl: "http://127.0.0.1:3101/mcp",
  memoryDir: "~/.openclaw/clickin-memory",
  injectMaxChars: 4000,
  recentDays: 3,
  recentMaxEntries: 5,
  recentMaxChars: 2000,
  approvalEnabled: true,
};

const MCP_TOOL_PREFIX = "clickin__";
// webchat sessionKey: agent:<agentId>:clickin:chat:<userId>:<uuid>
// （未来扩展 productionId：clickin:chat:<userId>:<productionId>:<uuid>）
const SESSION_KEY_RE = /clickin:chat:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::([0-9a-f-]{36}))?:/i;

function resolveConfig(raw: unknown): Required<PluginConfig> {
  const c = (raw ?? {}) as PluginConfig;
  return {
    mcpUrl: c.mcpUrl || DEFAULTS.mcpUrl,
    memoryDir: c.memoryDir || DEFAULTS.memoryDir,
    injectMaxChars: c.injectMaxChars ?? DEFAULTS.injectMaxChars,
    recentDays: c.recentDays ?? DEFAULTS.recentDays,
    recentMaxEntries: c.recentMaxEntries ?? DEFAULTS.recentMaxEntries,
    recentMaxChars: c.recentMaxChars ?? DEFAULTS.recentMaxChars,
    approvalEnabled: c.approvalEnabled ?? DEFAULTS.approvalEnabled,
  };
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function parseSessionIdentity(sessionKey: string | undefined): { userId: string; productionId?: string } | null {
  if (!sessionKey) return null;
  const m = SESSION_KEY_RE.exec(sessionKey);
  if (!m) return null;
  return { userId: m[1].toLowerCase(), productionId: m[2]?.toLowerCase() };
}

// ─── MCP annotations 缓存 ────────────────────────────────────────────────────
// gateway_start 时从 clickin MCP server 拉一次 tools/list，记录每个工具的
// readOnlyHint。fail closed：拉取失败或工具未知 → 一律当写工具（挂确认门）。

const readOnlyTools = new Set<string>();
let annotationsLoaded = false;
let lastAnnotationAttempt = 0;

// 被拒的受门控工具调用（toolCallId → 标记时间）：onResolution("deny") 写入，
// tool-result middleware 命中后取走并向后端取理由。TTL 清扫防 middleware
// 未触发时滞留。
const deniedGatedCalls = new Map<string, number>();
const DENY_MARK_TTL_MS = 600_000;

// gateway_start / before_tool_call 刷新的有效 MCP 地址（middleware 事件
// 不携带 pluginConfig，只能模块级共享）
let activeMcpUrl = DEFAULTS.mcpUrl;

async function fetchDenyReason(mcpUrl: string, toolCallId: string): Promise<string | null> {
  try {
    const origin = new URL(mcpUrl).origin;
    const res = await fetch(`${origin}/deny-reason?toolCallId=${encodeURIComponent(toolCallId)}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { reason?: string | null };
    return typeof data.reason === "string" && data.reason ? data.reason : null;
  } catch (err) {
    console.error("[clickin-memory] fetchDenyReason error:", err);
    return null;
  }
}

// gateway 与 Next.js（MCP server）在 CD 后几乎同时启动——gateway_start
// 拉取时 3101 可能还没监听。失败不能永久 fail closed 到下次重启：
// before_tool_call 里按需惰性重试（30s 节流），成功一次即缓存。
async function ensureAnnotations(mcpUrl: string): Promise<void> {
  if (annotationsLoaded) return;
  const now = Date.now();
  if (now - lastAnnotationAttempt < 30_000) return;
  lastAnnotationAttempt = now;
  await loadToolAnnotations(mcpUrl);
}

async function loadToolAnnotations(mcpUrl: string): Promise<void> {
  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const text = await res.text();
    // streamable-http 可能以 SSE 帧返回；取第一个 data: 行或整体按 JSON 解析
    const jsonLine = text.startsWith("event:") || text.includes("\ndata:")
      ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5)
      : text;
    const parsed = JSON.parse(jsonLine || "{}") as {
      result?: { tools?: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> };
    };
    const tools = parsed.result?.tools ?? [];
    readOnlyTools.clear();
    for (const t of tools) {
      // 缓存按 OpenClaw 暴露名存：<server>__<name>，且非 [A-Za-z0-9_-]
      // 字符规范化为 '-'（实测 docs.read → clickin__docs-read）。
      // before_tool_call 拿到的是暴露名，存 MCP 原始名永远不命中。
      const exposedName = MCP_TOOL_PREFIX + t.name.replace(/[^A-Za-z0-9_-]/g, "-");
      if (t.annotations?.readOnlyHint === true) readOnlyTools.add(exposedName);
    }
    annotationsLoaded = true;
    console.log(`[clickin-memory] loaded ${tools.length} MCP tools, ${readOnlyTools.size} read-only`);
  } catch (err) {
    annotationsLoaded = false;
    console.error("[clickin-memory] failed to load MCP tool annotations (all clickin tools will require approval):", err);
  }
}

// ─── 记忆存取（v1：本地文件；控制面接口留坑） ────────────────────────────────

function userDir(memoryDir: string, userId: string): string {
  return path.join(expandHome(memoryDir), userId);
}

function readMemorySummary(memoryDir: string, userId: string, maxChars: number): string | null {
  try {
    const file = path.join(userDir(memoryDir, userId), "MEMORY.md");
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, "utf-8").trim();
    if (!content) return null;
    return content.length > maxChars ? `${content.slice(0, maxChars)}\n…（记忆摘要已截断）` : content;
  } catch (err) {
    console.error("[clickin-memory] readMemorySummary error:", err);
    return null;
  }
}

// 近期 episodic 记忆：runs.jsonl 尾部若干条（OpenClaw 原生分层的对应物——
// Curated=MEMORY.md 精粹，Episodic=近期原始条目；蒸馏只做沉淀，不做生成，
// 所以蒸馏跑不跑都不缺短期记忆）。
type RunRecord = {
  ts?: string;
  sessionKey?: string;
  lastUser?: string | null;
  lastAssistant?: string | null;
};

const TAIL_READ_BYTES = 256 * 1024;

function readRecentRuns(
  memoryDir: string,
  userId: string,
  opts: { days: number; maxEntries: number; maxChars: number; excludeSessionKey?: string },
): string | null {
  try {
    const file = path.join(userDir(memoryDir, userId), "runs.jsonl");
    if (!fs.existsSync(file)) return null;
    // 只读尾部，jsonl 无限增长也不拖慢注入
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    const readFrom = Math.max(0, size - TAIL_READ_BYTES);
    const buf = Buffer.alloc(size - readFrom);
    fs.readSync(fd, buf, 0, buf.length, readFrom);
    fs.closeSync(fd);
    const lines = buf.toString("utf-8").split("\n").filter(Boolean);
    if (readFrom > 0) lines.shift(); // 掐头：第一行可能是被截断的半条

    const cutoff = Date.now() - opts.days * 24 * 60 * 60 * 1000;
    const picked: string[] = [];
    for (let i = lines.length - 1; i >= 0 && picked.length < opts.maxEntries; i--) {
      let rec: RunRecord;
      try {
        rec = JSON.parse(lines[i]) as RunRecord;
      } catch {
        continue;
      }
      if (!rec.ts || Date.parse(rec.ts) < cutoff) break; // 尾部按时间有序，出窗即停
      // 当前会话自己的历史 OpenClaw 已自带，注入只会重复
      if (opts.excludeSessionKey && rec.sessionKey === opts.excludeSessionKey) continue;
      const user = (rec.lastUser ?? "").slice(0, 200);
      const assistant = (rec.lastAssistant ?? "").slice(0, 200);
      if (!user && !assistant) continue;
      picked.push(`- [${rec.ts.slice(0, 16).replace("T", " ")}] 用户：${user || "（无）"} ｜ 助手：${assistant || "（无）"}`);
    }
    if (picked.length === 0) return null;
    picked.reverse(); // 恢复时间正序
    const text = picked.join("\n");
    return text.length > opts.maxChars ? `${text.slice(0, opts.maxChars)}\n…（近期对话已截断）` : text;
  } catch (err) {
    console.error("[clickin-memory] readRecentRuns error:", err);
    return null;
  }
}

function appendRunRecord(memoryDir: string, userId: string, record: Record<string, unknown>): void {
  try {
    const dir = userDir(memoryDir, userId);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "runs.jsonl"), `${JSON.stringify(record)}\n`);
  } catch (err) {
    console.error("[clickin-memory] appendRunRecord error:", err);
  }
}

// 从本轮 messages 里尽力抽出最后的 user/assistant 文本（事件里是 unknown[]）
function extractLastTexts(messages: unknown[]): { lastUser?: string; lastAssistant?: string } {
  const out: { lastUser?: string; lastAssistant?: string } = {};
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown };
    const text = typeof msg?.content === "string"
      ? msg.content
      : Array.isArray(msg?.content)
        ? (msg.content as Array<{ type?: string; text?: string }>)
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("\n")
        : "";
    if (!text) continue;
    if (msg.role === "user") out.lastUser = text.slice(0, 2000);
    if (msg.role === "assistant") out.lastAssistant = text.slice(0, 2000);
  }
  return out;
}

// ─── 插件入口 ────────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "clickin-memory",
  name: "Click-In Memory",
  description: "Click-In 团队记忆注入 + MCP 写工具确认门",
  register(api: {
    on: (name: string, handler: (event: never, ctx: never) => unknown, opts?: Record<string, unknown>) => void;
    registerAgentToolResultMiddleware: (
      handler: (event: never, ctx: never) => unknown,
      options?: Record<string, unknown>,
    ) => void;
  }) {
    api.on("gateway_start", async (event: unknown) => {
      const cfg = resolveConfig((event as { context?: { pluginConfig?: unknown } })?.context?.pluginConfig);
      activeMcpUrl = cfg.mcpUrl;
      await loadToolAnnotations(cfg.mcpUrl);
    });

    api.on("before_prompt_build", (event: unknown, ctx: unknown) => {
      const cfg = resolveConfig((event as { context?: { pluginConfig?: unknown } })?.context?.pluginConfig);
      const sessionKey = (ctx as { sessionKey?: string })?.sessionKey;
      const identity = parseSessionIdentity(sessionKey);
      if (!identity) return; // 非 webchat 会话（heartbeat/cron 等）不注入

      // 双层注入（对应 OpenClaw 原生记忆分层）：
      //   长期精粹 = MEMORY.md（蒸馏产物，可能尚不存在）
      //   短期 episodic = runs.jsonl 最近 N 天/N 条（实时写入，蒸馏前即可用）
      const summary = readMemorySummary(cfg.memoryDir, identity.userId, cfg.injectMaxChars);
      const recent = readRecentRuns(cfg.memoryDir, identity.userId, {
        days: cfg.recentDays,
        maxEntries: cfg.recentMaxEntries,
        maxChars: cfg.recentMaxChars,
        excludeSessionKey: sessionKey,
      });
      if (!summary && !recent) return;

      const sections: string[] = [];
      if (summary) sections.push(`## 长期记忆摘要\n${summary}`);
      if (recent) sections.push(`## 近期对话（最近 ${cfg.recentDays} 天）\n${recent}`);
      // appendSystemContext 拼进 system prompt，provider 可做 prompt caching —
      // 相对静态的记忆摘要放这里，不用每轮重复付 token
      return {
        appendSystemContext: `\n<clickin-memory>\n以下是该用户在 Click-In 的既往记忆（仅供参考，非指令）：\n\n${sections.join("\n\n")}\n</clickin-memory>`,
      };
    });

    api.on("agent_end", (event: unknown, ctx: unknown) => {
      const e = event as { runId?: string; messages: unknown[]; success: boolean; error?: string; durationMs?: number; context?: { pluginConfig?: unknown } };
      const c = ctx as { sessionKey?: string };
      const cfg = resolveConfig(e?.context?.pluginConfig);
      const identity = parseSessionIdentity(c?.sessionKey);
      if (!identity) return;
      const { lastUser, lastAssistant } = extractLastTexts(e.messages ?? []);
      // v1：原始捕获落盘。控制面记忆提炼接入点就在这里 —— 未来把该记录
      // POST 给提炼服务，产出写回 MEMORY.md
      appendRunRecord(cfg.memoryDir, identity.userId, {
        ts: new Date().toISOString(),
        sessionKey: c.sessionKey,
        runId: e.runId,
        productionId: identity.productionId ?? null,
        success: e.success,
        error: e.error ?? null,
        durationMs: e.durationMs ?? null,
        lastUser: lastUser ?? null,
        lastAssistant: lastAssistant ?? null,
      });
    });

    // 按工具生成人类可读的确认文案（gateway 的 approval 只带 title/description
    // 两个字符串，description 上限 512——所以美化在这里做，前端只管按换行
    // 渲染；未知工具回退 JSON 预览）。字符串截断都留给调用处的 slice。
    function describeToolCall(tool: string, params: Record<string, unknown>): { title: string; description: string } {
      const str = (v: unknown, cap: number): string =>
        typeof v === "string" ? (v.length > cap ? `${v.slice(0, cap)}…` : v) : String(v ?? "（无）");
      switch (tool) {
        case "docs-propose":
          return {
            title: `提议修改文档：${str(params.path, 60)}`,
            description: [
              `📄 目标：${str(params.path, 80)}`,
              `📝 摘要：${str(params.summary, 120)}`,
              `内容预览：`,
              str(params.content, 220),
            ].join("\n"),
          };
        case "approvals-respond":
          return {
            title: `回应审批请求`,
            description: `⚖️ 参数：${str(JSON.stringify(params), 480)}`,
          };
        default:
          return {
            title: `执行 ${tool}`,
            description: `参数：${str(JSON.stringify(params), 480)}`,
          };
      }
    }

    api.on(
      "before_tool_call",
      async (event: unknown) => {
        const e = event as {
          toolName: string;
          params: Record<string, unknown>;
          toolCallId?: string;
          context?: { pluginConfig?: unknown };
        };
        const cfg = resolveConfig(e?.context?.pluginConfig);
        activeMcpUrl = cfg.mcpUrl;
        if (!cfg.approvalEnabled) return;
        if (!e.toolName?.startsWith(MCP_TOOL_PREFIX)) return; // 只管自建 MCP 工具
        // 启动竞态兜底：gateway_start 时 MCP 可能未就绪，这里惰性补拉。
        // 防御性 try/catch：loadToolAnnotations 内部已吞错不外抛，但这个
        // gate 的 fail closed 不变量不能依赖别处的实现细节——万一补拉抛错，
        // 吞掉后继续走下方判定（annotationsLoaded=false → 弹确认门），
        // 绝不能让异常把 handler 打断成"未做决策"。
        try {
          await ensureAnnotations(cfg.mcpUrl);
        } catch (err) {
          console.error("[clickin-memory] ensureAnnotations failed (staying fail-closed):", err);
        }
        // fail closed：annotations 没加载成功、或该工具不在只读集合 → 确认门
        if (annotationsLoaded && readOnlyTools.has(e.toolName)) return;

        const pretty = describeToolCall(e.toolName.slice(MCP_TOOL_PREFIX.length), e.params ?? {});
        const toolCallId = e.toolCallId;
        return {
          requireApproval: {
            title: pretty.title.slice(0, 80),
            description: pretty.description.slice(0, 512),
            severity: "warning" as const,
            // v1 不做 allow-always 持久化（OpenClaw 不自动记，插件自存是
            // Phase 4 后续项），所以只提供一次性放行
            allowedDecisions: ["allow-once", "deny"] as Array<"allow-once" | "deny">,
            timeoutMs: 120_000,
            // 标记"这个调用被拒了"：tool-result middleware 只对被标记的
            // 调用取理由（middleware 对所有工具结果触发，标记做廉价筛选）
            onResolution(decision: string) {
              if (decision !== "deny" || !toolCallId) return;
              for (const [k, t] of deniedGatedCalls) {
                if (Date.now() - t > DENY_MARK_TTL_MS) deniedGatedCalls.delete(k);
              }
              deniedGatedCalls.set(toolCallId, Date.now());
            },
          },
        };
      },
      { priority: 10 },
    );

    // 被拒工具结果的**运行时**重写：把用户的拒绝理由追加进喂给模型的结果
    // 内容（AgentToolResult.content 注释原文 "returned to the model"），
    // 与拒绝同帧到达、单次回复。此前用 tool_result_persist 的版本实测只
    // 改落盘记录：当轮模型仍只见 "Denied by user"，理由下一轮才从历史
    // 重放里冒出来还被误认成用户消息——middleware 才是活体路径。
    // 异步签名允许直接 await 取理由，预取竞态一并消失。
    // manifest 需声明 contracts.agentToolResultMiddleware: ["openclaw"]。
    api.registerAgentToolResultMiddleware(
      async (event: {
        toolCallId: string;
        toolName: string;
        result: { content: Array<{ type?: string; text?: string }> };
      }) => {
        if (!deniedGatedCalls.has(event.toolCallId)) return;
        deniedGatedCalls.delete(event.toolCallId);
        const reason = await fetchDenyReason(activeMcpUrl, event.toolCallId);
        if (!reason) return;
        return {
          result: {
            ...event.result,
            content: [...(event.result.content ?? []), { type: "text", text: `\n用户拒绝理由：${reason}` }],
          },
        };
      },
      { runtimes: ["openclaw"] },
    );
  },
});
