import type { BotContext } from "./types";
import { replySkill, buildSkillsPrompt, dispatchSkill } from "./skills/_registry";
import { chat } from "./llm";
import type { Message } from "./llm";
import { buildMessages } from "./prompt";
import type { PromptVars } from "./prompt";
import { BASE_PROMPT } from "./prompts/_base";
import { saveSession, loadSession, deleteSession } from "./db";
import type { CtxSnapshot } from "./db";

const MAX_LOOPS        = parseInt(process.env.AGENT_MAX_LOOPS ?? "10", 10);
const REPLY_TIMEOUT_MS = parseInt(process.env.AGENT_REPLY_TIMEOUT_MS ?? String(5 * 60 * 1000), 10);

type AgentResponse = {
  skill: string;
  args: unknown;
  reason: string;
  done: boolean;
  wait_reply?: boolean;
};

// LLMs sometimes emit non-ASCII punctuation instead of ASCII inside JSON.
const RE_CURLY_QUOTES = /[""]/g;
const RE_FW_COMMA     = /，/g;
const RE_FW_COLON     = /：/g;
// LLMs sometimes write "key=value" instead of "key":value.
const RE_KV_EQ = /"(\w+)=(true|false|null|-?\d+(?:\.\d+)?)/g;

function parseAgentResponse(raw: string): AgentResponse {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```$/m, "")
    .trim()
    .replace(RE_CURLY_QUOTES, '"')
    .replace(RE_FW_COMMA, ",")
    .replace(RE_FW_COLON, ":")
    .replace(RE_KV_EQ, '"$1":$2');
  return JSON.parse(cleaned) as AgentResponse;
}

export function sessionKey(ctx: BotContext): string {
  return `${ctx.trigger.chatId}:${ctx.trigger.senderId}`;
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

function formatHistory(ctx: BotContext): string {
  if (ctx.history.length === 0) return "（无）";
  return ctx.history
    .slice()
    .reverse()
    .map(m => {
      const d = new Date(m.timestamp + 8 * 3_600_000);
      const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
      const who  = m.senderType === "app" ? "助手" : m.senderName;
      const body =
        m.type === "text" ? (m.text ?? "") :
        m.type === "card" ? `[系统卡片: ${m.cardTitle}]` :
        "[其他消息]";
      return `[${hhmm}] ${who}: ${body}`;
    })
    .join("\n");
}

async function runLoop(ctx: BotContext, initialMessages: Message[]): Promise<void> {
  let messages = initialMessages;
  let loops = 0;
  let done = false;

  while (!done && loops < MAX_LOOPS) {
    loops++;
    console.log(`[agent] loop ${loops}, messages:\n` + JSON.stringify(messages, null, 2));

    const raw = await chat(messages);
    console.log(`[agent] loop ${loops} raw response: ${raw}`);

    let response: AgentResponse;
    try {
      response = parseAgentResponse(raw);
    } catch (e) {
      console.error("[agent] failed to parse LLM response:", raw, e);
      await replySkill.run(ctx, { text: "抱歉，处理你的请求时出现了内部错误。" });
      return;
    }

    console.log(`[agent] loop ${loops}: skill=${response.skill} done=${response.done} wait_reply=${response.wait_reply} reason=${response.reason}`);

    try {
      await dispatchSkill(ctx, response.skill, response.args);
    } catch (e) {
      console.error("[agent] skill dispatch error:", e);
      await replySkill.run(ctx, { text: "抱歉，执行操作时出现了错误。" });
      return;
    }

    if (response.wait_reply) {
      const key        = sessionKey(ctx);
      const checkpoint = [...messages, { role: "assistant" as const, content: raw }];
      await saveSession(key, checkpoint, ctxSnapshot(ctx), REPLY_TIMEOUT_MS);
      console.log(`[agent] session suspended key=${key} timeout=${REPLY_TIMEOUT_MS}ms`);
      return;
    }

    if (response.done) {
      done = true;
    } else {
      messages = [
        ...messages,
        { role: "assistant", content: raw },
        { role: "user", content: `技能 "${response.skill}" 已执行完毕，请继续。` },
      ];
    }
  }

  if (!done) {
    console.warn(`[agent] max loops (${MAX_LOOPS}) reached, terminating session`);
    await replySkill.run(ctx, { text: "抱歉，处理超时，请重试或换一种方式提问。" });
  }
}

export async function processMessage(ctx: BotContext): Promise<void> {
  console.log("[agent] context:\n" + JSON.stringify(ctx, null, 2));
  if (!ctx.trigger.text.trim()) return;

  const key     = sessionKey(ctx);
  const pending = await loadSession(key).catch(e => {
    console.error("[agent] loadSession error:", e);
    return null;
  });

  let initialMessages: Message[];

  if (pending) {
    await deleteSession(key);
    console.log(`[agent] resuming session key=${key} expired=${pending.expired}`);

    if (pending.expired) {
      initialMessages = [
        ...pending.messages,
        { role: "system", content: "系统通知：用户超时未回复，等待已结束。你可以决定执行后续任务、通知用户或结束会话。" },
      ];
    } else {
      initialMessages = [...pending.messages, { role: "user", content: ctx.trigger.text }];
    }
  } else {
    const vars: PromptVars = {
      chatName:   ctx.chat.name,
      chatType:   ctx.trigger.chatType === "p2p" ? "单聊" : "群聊",
      senderName: ctx.trigger.senderName,
      history:    formatHistory(ctx),
      skills:     buildSkillsPrompt(),
    };
    initialMessages = [
      ...buildMessages(BASE_PROMPT, vars),
      { role: "user", content: ctx.trigger.text },
    ];
  }

  await runLoop(ctx, initialMessages);
}

// Called by the card-action webhook when a user clicks a button.
// Returns the outcome so the webhook can send an appropriate toast response.
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
  const userContent = `用户点击了按钮「${buttonLabel}」，选择：${buttonValue}`;
  const messages: Message[] = [...pending.messages, { role: "user", content: userContent }];

  void runLoop(ctx, messages).catch(err =>
    console.error("[agent] button click loop error:", err),
  );

  return "ok";
}
