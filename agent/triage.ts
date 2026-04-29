import { chat } from "./llm";

export type TriageAction = "ignore" | "record_only" | "respond";

// Short-term group context buffer — module-level, cleared on restart
const MAX_BUFFER = 20;
const groupBuffers = new Map<string, string[]>();

export function appendGroupContext(chatId: string, entry: string): void {
  const buf = groupBuffers.get(chatId) ?? [];
  buf.push(entry);
  if (buf.length > MAX_BUFFER) buf.shift();
  groupBuffers.set(chatId, buf);
}

export function getGroupContext(chatId: string): string[] {
  return [...(groupBuffers.get(chatId) ?? [])];
}

const TRIAGE_PROMPT = `你是群聊消息路由器，决定机器人如何处理以下消息。
只输出 JSON，不含其他文字：{"action":"respond"|"record_only"|"ignore","reason":"一句话"}

action 含义：
- respond：用户明确需要 bot 回复或执行任务
- record_only：消息有价值（讨论、信息共享、决策）但不需要 bot 介入
- ignore：纯闲聊、表情符号、简短反应、与剧团工作完全无关的内容

群组：{{chatName}}
近期消息（从旧到新）：
{{recentHistory}}
新消息（{{senderName}}）：{{message}}`;

export async function triageGroupMessage(
  chatName: string,
  senderName: string,
  message: string,
  recentHistory: string,
): Promise<TriageAction> {
  const prompt = TRIAGE_PROMPT
    .replace("{{chatName}}", chatName)
    .replace("{{senderName}}", senderName)
    .replace("{{recentHistory}}", recentHistory || "（无）")
    .replace("{{message}}", message);

  try {
    const raw = await chat(
      [{ role: "user", content: prompt }],
      { maxTokens: 80, temperature: 0.1 },
    );
    const cleaned = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();
    const parsed = JSON.parse(cleaned) as { action: string; reason: string };
    const action = parsed.action as TriageAction;
    if (!["ignore", "record_only", "respond"].includes(action)) {
      console.warn(`[triage] unknown action "${action}", defaulting to respond`);
      return "respond";
    }
    console.log(`[triage] ${senderName}: "${message.slice(0, 40)}" → ${action} — ${parsed.reason}`);
    return action;
  } catch (e) {
    console.error("[triage] error, defaulting to respond:", e);
    return "respond";
  }
}
