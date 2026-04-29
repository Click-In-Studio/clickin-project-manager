import type { BotContext } from "./types";
import { replySkill, buildSkillsPrompt, dispatchSkill, skillRegistry } from "./skills/_registry";
import { chat } from "./llm";
import type { Message } from "./llm";
import { buildMessages } from "./prompt";
import type { PromptVars } from "./prompt";
import { BASE_PROMPT } from "./prompts/_base";
import { saveSession, loadSession, deleteSession, tryConsumeSession, consumeExpiredSession, getChatProductionContext, setChatProductionContext } from "./db";
import type { CtxSnapshot } from "./db";
import { loadMemory, compactAndSave, digestHistory } from "./memory";
import { FOCUS_PRODUCTION_MARKER } from "./skills/focus-production/index";
import { triageGroupMessage, appendGroupContext, getGroupContext } from "./triage";

const MAX_LOOPS        = parseInt(process.env.AGENT_MAX_LOOPS ?? "10", 10);
const REPLY_TIMEOUT_MS = parseInt(process.env.AGENT_REPLY_TIMEOUT_MS ?? String(5 * 60 * 1000), 10);

type AgentResponse = {
  skill: string;
  args: unknown;
  reason: string;
  done: boolean;
  wait_reply?: boolean;
};

type CancelToken = { cancelled: boolean };
type ActiveLoop  = { token: CancelToken; pendingContents: string[] };
// Tracks in-progress agent loops per session key for supersede/merge logic
const activeLoops = new Map<string, ActiveLoop>();

// ─── Proactive session timeout ────────────────────────────────────────────────

const pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSessionTimeout(key: string, delayMs: number): void {
  const existing = pendingTimeouts.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingTimeouts.delete(key);
    void onSessionTimeout(key).catch(e => console.error("[agent] session timeout error:", e));
  }, delayMs + 200); // +200 ms buffer for DB clock skew
  pendingTimeouts.set(key, timer);
}

function clearScheduledTimeout(key: string): void {
  const t = pendingTimeouts.get(key);
  if (t) { clearTimeout(t); pendingTimeouts.delete(key); }
}

async function onSessionTimeout(key: string): Promise<void> {
  const session = await consumeExpiredSession(key);
  if (!session) return; // user message already consumed the session
  console.log(`[agent] session timeout fired: key=${key}`);
  const ctx = snapshotToCtx(session.ctxSnapshot);
  await attachProductionContext(ctx);
  const messages: Message[] = [
    ...session.messages,
    {
      role: "system",
      content: "系统通知：用户超时未回复，本次等待已结束。请立即调用 reply 向用户说明对话已因超时结束，然后将 done 设为 true 关闭本次会话。禁止再次设置 wait_reply:true。",
    },
  ];
  await runLoop(ctx, messages);
}

// LLMs sometimes emit non-ASCII punctuation instead of ASCII inside JSON.
const RE_CURLY_QUOTES = /[""]/g;
const RE_FW_COMMA     = /，/g;
const RE_FW_COLON     = /：/g;
// LLMs sometimes write "key=value" instead of "key":value.
const RE_KV_EQ = /"(\w+)=(true|false|null|-?\d+(?:\.\d+)?)/g;

// Escape literal newlines/carriage-returns that appear inside JSON string values.
// Actual \n inside a string is invalid JSON; LLMs emit it when generating multi-line text.
function escapeNewlinesInStrings(s: string): string {
  let inString = false;
  let escaped  = false;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      out += ch; escaped = false;
    } else if (ch === "\\") {
      out += ch; escaped = true;
    } else if (ch === '"') {
      out += ch; inString = !inString;
    } else if (inString && ch === "\n") {
      out += "\\n";
    } else if (inString && ch === "\r") {
      out += "\\r";
    } else {
      out += ch;
    }
  }
  return out;
}

function parseAgentResponse(raw: string): AgentResponse {
  const cleaned = escapeNewlinesInStrings(
    raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "")
      .trim()
      .replace(RE_CURLY_QUOTES, '"')
      .replace(RE_FW_COMMA, ",")
      .replace(RE_FW_COLON, ":")
      .replace(RE_KV_EQ, '"$1":$2'),
  );
  return JSON.parse(cleaned) as AgentResponse;
}

export function sessionKey(ctx: BotContext): string {
  // Group chats share a single session across all participants
  if (ctx.trigger.chatType === "group") return `group:${ctx.trigger.chatId}`;
  return `${ctx.trigger.chatId}:${ctx.trigger.senderId}`;
}

function groupUserContent(ctx: BotContext): string {
  return `[${ctx.trigger.senderName}]: ${ctx.trigger.text}`;
}

function ctxSnapshot(ctx: BotContext): CtxSnapshot {
  return {
    chatId:     ctx.trigger.chatId,
    chatType:   ctx.trigger.chatType,
    senderId:   ctx.trigger.senderId,
    senderName: ctx.trigger.senderName,
    chatName:   ctx.chat.name,
  };
}

function snapshotToCtx(snap: CtxSnapshot): BotContext {
  return {
    trigger: {
      messageId:  "",
      chatId:     snap.chatId,
      chatType:   snap.chatType,
      senderId:   snap.senderId,
      senderName: snap.senderName,
      text:       "",
      rawText:    "",
      timestamp:  Date.now(),
    },
    chat:    { name: snap.chatName },
    history: [],
  };
}

async function attachProductionContext(ctx: BotContext): Promise<void> {
  const prodCtx = await getChatProductionContext(ctx.trigger.chatId);
  if (prodCtx) {
    ctx.productionContext = { productionId: prodCtx.id, productionName: prodCtx.name };
  }
}


// Backend enforcement: fix up LLM response before acting on it.
function enforceConstraints(response: AgentResponse): AgentResponse {
  if (response.skill === "send_card") {
    const args = response.args as { buttons?: unknown[] } | null | undefined;
    const hasButtons = Array.isArray(args?.buttons) && args.buttons.length > 0;
    if (hasButtons && !response.wait_reply) {
      console.warn("[agent] enforcing wait_reply=true for send_card with buttons");
      return { ...response, wait_reply: true };
    }
    if (!hasButtons && response.wait_reply) {
      console.warn("[agent] enforcing wait_reply=false for send_card without buttons");
      return { ...response, wait_reply: false };
    }
  }
  if (response.skill === "list_skills" && response.wait_reply) {
    console.warn("[agent] enforcing wait_reply=false for list_skills");
    return { ...response, wait_reply: false };
  }
  if (response.skill === "focus_production" && !response.wait_reply) {
    console.warn("[agent] enforcing wait_reply=true for focus_production");
    return { ...response, wait_reply: true };
  }
  if ((response.skill === "query_events" || response.skill === "get_event_detail") && response.wait_reply) {
    console.warn(`[agent] enforcing wait_reply=false for ${response.skill}`);
    return { ...response, wait_reply: false };
  }
  return response;
}

// Handles an async skill with wait_reply:true.
// Sends a pending-message to the user, saves the session, then executes.
const JSON_REMINDER = "你仍然处于 agent loop 中，必须输出 JSON 指令。";

function buildSkillResultContent(skill: string, result: string | undefined, error: string | undefined): string {
  if (error) {
    return `技能 "${skill}" 执行失败：${error}\n请检查技能名称和参数后重试，或改用其他方式完成任务。\n${JSON_REMINDER}`;
  }
  if (result) {
    return `以下是 "${skill}" 的返回数据，仅供你决策下一步 action 使用。\n\n${result}\n\n${JSON_REMINDER}`;
  }
  return `技能 "${skill}" 已执行完毕（无返回数据）。\n${JSON_REMINDER}`;
}

// On completion, atomically tries to consume the session:
//   - success → auto-resume loop with result
//   - failure → user already consumed session; discard result
async function runAsyncSkill(
  ctx:          BotContext,
  response:     AgentResponse,
  messages:     Message[],
  raw:          string,
  cancelToken?: CancelToken,
): Promise<void> {
  const key        = sessionKey(ctx);
  const checkpoint = [...messages, { role: "assistant" as const, content: raw }];

  // Notify user that we are processing, before we go off to do the query.
  const pendingMsg =
    skillRegistry[response.skill]?.config.pendingMessage ?? "收到，正在处理，请稍候…";
  await replySkill.run(ctx, { text: pendingMsg });

  await saveSession(key, checkpoint, ctxSnapshot(ctx), REPLY_TIMEOUT_MS);
  console.log(`[agent] async skill: session saved key=${key}, executing ${response.skill}`);

  let skillResult: string | undefined;
  let skillError: string | undefined;
  try {
    skillResult = await dispatchSkill(ctx, response.skill, response.args);
  } catch (e) {
    skillError = e instanceof Error ? e.message : String(e);
    console.error(`[agent] async skill ${response.skill} error:`, skillError);
  }

  // Race: try to atomically consume the session
  const consumed = await tryConsumeSession(key);
  if (!consumed) {
    // User sent a message first and consumed the session — they win
    console.log(`[agent] async skill ${response.skill}: result discarded, user interrupted`);
    return;
  }

  // We got the session — auto-resume with skill result (or error) injected
  console.log(`[agent] async skill ${response.skill}: auto-resuming with result`);
  const resultContent = buildSkillResultContent(response.skill, skillResult, skillError);
  const resumeMessages: Message[] = [
    ...checkpoint,
    { role: "system", content: resultContent },
  ];
  await runLoop(ctx, resumeMessages, cancelToken);
}

async function runLoop(ctx: BotContext, initialMessages: Message[], cancelToken?: CancelToken): Promise<void> {
  let messages = initialMessages;
  let loops = 0;
  let done = false;

  while (!done && loops < MAX_LOOPS) {
    loops++;

    if (cancelToken?.cancelled) {
      console.log(`[agent] loop ${loops} cancelled before LLM call`);
      return;
    }

    console.log(`[agent] loop ${loops}, messages:\n` + JSON.stringify(messages, null, 2));

    const raw = await chat(messages);
    console.log(`[agent] loop ${loops} raw response: ${raw}`);

    let response: AgentResponse;
    try {
      response = parseAgentResponse(raw);
    } catch (e) {
      console.error("[agent] failed to parse LLM response:", raw, e);
      messages = [
        ...messages,
        { role: "assistant" as const, content: raw },
        {
          role: "system" as const,
          content: `你的输出无法解析为合法 JSON。\n必须严格只输出以下格式，不得包含任何其他文字、解释或 markdown：\n{"skill":"<技能名>","args":{<参数>},"reason":"<原因>","done":true或false,"wait_reply":true或false}\n${JSON_REMINDER}`,
        },
      ];
      continue;
    }

    response = enforceConstraints(response);

    if (cancelToken?.cancelled) {
      console.log(`[agent] loop ${loops} cancelled after LLM response, skill discarded`);
      return;
    }

    console.log(`[agent] loop ${loops}: skill=${response.skill} done=${response.done} wait_reply=${response.wait_reply} reason=${response.reason}`);

    const isAsync = skillRegistry[response.skill]?.config.mode === "async";

    // Async skill + wait_reply: save session first, execute, then race
    if (response.wait_reply && isAsync) {
      await runAsyncSkill(ctx, response, messages, raw, cancelToken);
      return;
    }

    // Sync execution path
    let skillResult: string | undefined;
    let skillError: string | undefined;
    try {
      skillResult = await dispatchSkill(ctx, response.skill, response.args);
    } catch (e) {
      skillError = e instanceof Error ? e.message : String(e);
      console.error("[agent] skill dispatch error:", skillError);
    }

    if (skillError !== undefined) {
      // Feed the error back to the agent rather than surfacing it to the user
      messages = [
        ...messages,
        { role: "assistant" as const, content: raw },
        { role: "system", content: buildSkillResultContent(response.skill, undefined, skillError) },
      ];
      continue;
    }

    if (response.wait_reply) {
      // Sync wait_reply: include skill result (if any) in checkpoint
      const assistantMsg = { role: "assistant" as const, content: raw };
      const checkpoint: Message[] = [
        ...messages,
        assistantMsg,
        ...(skillResult ? [{ role: "system" as const, content: buildSkillResultContent(response.skill, skillResult, undefined) }] : []),
      ];
      const key = sessionKey(ctx);
      await saveSession(key, checkpoint, ctxSnapshot(ctx), REPLY_TIMEOUT_MS);
      scheduleSessionTimeout(key, REPLY_TIMEOUT_MS);
      console.log(`[agent] session suspended key=${key} timeout=${REPLY_TIMEOUT_MS}ms`);
      return;
    }

    if (response.done) {
      done = true;
      // Include the final assistant response so compact captures the full exchange
      const finalMessages = [...messages, { role: "assistant" as const, content: raw }];
      compactAndSave(
        ctx.trigger.chatId,
        ctx.trigger.senderId,
        ctx.trigger.senderName,
        finalMessages,
      ).catch(e => console.error("[agent] compactAndSave error:", e));
    } else {
      const continuationContent = buildSkillResultContent(response.skill, skillResult, undefined);
      messages = [
        ...messages,
        { role: "assistant", content: raw },
        { role: "system", content: continuationContent },
      ];
    }
  }

  if (!done) {
    console.warn(`[agent] max loops (${MAX_LOOPS}) reached, terminating session`);
    await replySkill.run(ctx, { text: "抱歉，处理超时，请重试或换一种方式提问。" });
  }
}

export async function processMessage(ctx: BotContext): Promise<void> {
  if (!ctx.trigger.text.trim()) return;

  const key     = sessionKey(ctx);
  const pending = await loadSession(key).catch(e => {
    console.error("[agent] loadSession error:", e);
    return null;
  });

  let initialMessages: Message[];
  let loopToken: CancelToken | undefined;

  if (pending) {
    clearScheduledTimeout(key);
    await deleteSession(key);
    console.log(`[agent] resuming session key=${key} expired=${pending.expired}`);

    if (pending.expired) {
      initialMessages = [
        ...pending.messages,
        { role: "system", content: "系统通知：用户超时未回复，等待已结束。你可以决定执行后续任务、通知用户或结束会话。" },
      ];
    } else {
      const userContent = ctx.trigger.chatType === "group"
        ? groupUserContent(ctx)
        : ctx.trigger.text;

      // For group sessions: notify the LLM when a new participant sends their first message
      const isNewParticipant = ctx.trigger.chatType === "group" &&
        !pending.messages.some(
          m => m.role === "user" && m.content.startsWith(`[${ctx.trigger.senderName}]:`)
        );

      initialMessages = isNewParticipant
        ? [
            ...pending.messages,
            { role: "system", content: `群成员「${ctx.trigger.senderName}」加入了讨论。` },
            { role: "user", content: userContent },
          ]
        : [...pending.messages, { role: "user", content: userContent }];
    }
  } else {
    const isGroup = ctx.trigger.chatType === "group";

    // Triage: only for group messages not directly @mentioning the bot
    if (isGroup && !ctx.trigger.mentionedBot) {
      const triageHistoryStr = ctx.history
        .slice(0, 5)
        .reverse()
        .map(m => {
          const d = new Date(m.timestamp + 8 * 3_600_000);
          const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
          const who  = m.senderType === "app" ? "Bot" : m.senderName;
          const text =
            m.type === "text"  ? (m.text ?? "") :
            m.type === "card"  ? `[卡片: ${m.cardTitle}]` :
            "[其他]";
          return `[${hhmm}] ${who}: ${text}`;
        })
        .join("\n");

      const action = await triageGroupMessage(
        ctx.chat.name,
        ctx.trigger.senderName,
        ctx.trigger.text,
        triageHistoryStr,
      );

      if (action === "ignore") return;
      if (action === "record_only") {
        const d    = new Date(ctx.trigger.timestamp + 8 * 3_600_000);
        const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
        appendGroupContext(ctx.trigger.chatId, `[${hhmm}] ${ctx.trigger.senderName}: ${ctx.trigger.text}`);
        return;
      }
      // action === "respond": fall through
    }

    // Cancel any in-progress loop; collect its pending messages for merging
    const prevLoop = activeLoops.get(key);
    const prevContents: string[] = prevLoop ? [...prevLoop.pendingContents] : [];
    if (prevLoop) {
      prevLoop.token.cancelled = true;
      console.log(`[agent] key=${key}: superseded, merging ${prevContents.length + 1} message(s)`);
    }
    const token: CancelToken = { cancelled: false };
    const userContent = isGroup ? groupUserContent(ctx) : ctx.trigger.text;
    const allContents = [...prevContents, userContent];
    activeLoops.set(key, { token, pendingContents: allContents });
    loopToken = token;

    const [mem, prodCtx, historyDigest] = await Promise.all([
      loadMemory(ctx.trigger.chatId, ctx.trigger.senderId),
      getChatProductionContext(ctx.trigger.chatId),
      digestHistory(ctx.history),
    ]);
    const groupCtxEntries = isGroup ? getGroupContext(ctx.trigger.chatId) : [];
    if (prodCtx) {
      ctx.productionContext = { productionId: prodCtx.id, productionName: prodCtx.name };
    }
    const productionContext = prodCtx
      ? `《${prodCtx.name}》（ID: ${prodCtx.id}）。如上下文暗示切换到其他 production，可重新调用 focus_production 更新。`
      : `（未设置）。若任务需要针对特定 production 操作，请先调用 focus_production 让用户确认。`;
    const now = new Date().toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      weekday: "short", hour: "2-digit", minute: "2-digit",
    });
    const vars: PromptVars = {
      chatName:          ctx.chat.name,
      chatType:          isGroup ? "群聊" : "单聊",
      senderName:        ctx.trigger.senderName,
      history:           historyDigest,
      skills:            buildSkillsPrompt(),
      chatMemory:        mem.chatMemory || "（无）",
      userMemory:        mem.userMemory || "（无）",
      productionContext,
      now,
    };
    const groupCtxMsg = groupCtxEntries.length > 0 ? [{
      role: "system" as const,
      content: `# 群聊近期上下文（已记录、无需 bot 回复的消息）\n${groupCtxEntries.join("\n")}`,
    }] : [];

    if (allContents.length > 1) {
      initialMessages = [
        ...buildMessages(BASE_PROMPT, vars),
        ...groupCtxMsg,
        {
          role: "system" as const,
          content: `用户在等待回复期间连续发送了多条消息，请综合以下所有消息回复：\n${allContents.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
        },
        { role: "user" as const, content: userContent },
      ];
    } else {
      initialMessages = [
        ...buildMessages(BASE_PROMPT, vars),
        ...groupCtxMsg,
        { role: "user", content: userContent },
      ];
    }
  }

  try {
    await runLoop(ctx, initialMessages, loopToken);
  } finally {
    if (loopToken && activeLoops.get(key)?.token === loopToken) {
      activeLoops.delete(key);
    }
  }
}

export async function processButtonClick(
  key:         string,
  buttonValue: string,
  buttonLabel: string,
): Promise<"ok" | "expired" | "not_found"> {
  const pending = await loadSession(key).catch(e => {
    console.error("[agent] loadSession error (button click):", e);
    return null;
  });

  if (!pending) return "not_found";

  await deleteSession(key);

  if (pending.expired) return "expired";

  const ctx = snapshotToCtx(pending.ctxSnapshot);

  // Detect focus_production card responses and persist the selected production
  let userContent: string;
  try {
    const parsed = JSON.parse(buttonValue) as {
      marker?: string; production_id?: string; production_name?: string; rejected?: boolean;
    };
    if (parsed.marker === FOCUS_PRODUCTION_MARKER) {
      if (parsed.rejected) {
        userContent = "用户否定了所有选项，没有匹配的 production，production context 未更新";
      } else if (parsed.production_id && parsed.production_name) {
        await setChatProductionContext(pending.ctxSnapshot.chatId, parsed.production_id, parsed.production_name);
        ctx.productionContext = { productionId: parsed.production_id, productionName: parsed.production_name };
        userContent = `用户选择了《${parsed.production_name}》（ID: ${parsed.production_id}），production context 已更新`;
      } else {
        userContent = `用户点击了按钮「${buttonLabel}」，选择：${buttonValue}`;
      }
    } else {
      userContent = `用户点击了按钮「${buttonLabel}」，选择：${buttonValue}`;
    }
  } catch {
    userContent = `用户点击了按钮「${buttonLabel}」，选择：${buttonValue}`;
  }

  // Load any existing productionContext not yet set by focus_production handling above
  if (!ctx.productionContext) await attachProductionContext(ctx);

  const messages: Message[] = [...pending.messages, { role: "user", content: userContent }];

  void runLoop(ctx, messages).catch(err =>
    console.error("[agent] button click loop error:", err),
  );

  return "ok";
}
