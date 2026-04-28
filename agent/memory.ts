import type { Message } from "./llm";
import { chat } from "./llm";
import { buildMessages } from "./prompt";
import { getChatMemory, getUserMemory, saveChatMemory, saveUserMemory } from "./db";
import { COMPACT_CHAT_PROMPT } from "./prompts/_compact-chat";
import { COMPACT_USER_PROMPT } from "./prompts/_compact-user";

export type MemoryContext = {
  chatMemory: string;
  userMemory: string;
};

export async function loadMemory(chatId: string, senderId: string): Promise<MemoryContext> {
  const [chatMemory, userMemory] = await Promise.all([
    getChatMemory(chatId).catch(() => null),
    getUserMemory(senderId).catch(() => null),
  ]);
  return {
    chatMemory: chatMemory ?? "",
    userMemory: userMemory ?? "",
  };
}

function formatSessionTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      // Skip the base prompt boilerplate; include only skill results and system notifications
      if (!m.content.startsWith("技能") && !m.content.startsWith("系统通知")) continue;
      lines.push(`[系统]: ${m.content}`);
    } else if (m.role === "assistant") {
      try {
        const p = JSON.parse(m.content) as { skill: string; reason: string; args?: unknown };
        const argStr = p.args ? ` args=${JSON.stringify(p.args).slice(0, 200)}` : "";
        lines.push(`[助手] skill=${p.skill}${argStr} reason=${p.reason}`);
      } catch {
        lines.push(`[助手]: ${m.content.slice(0, 300)}`);
      }
    } else {
      lines.push(`[用户]: ${m.content}`);
    }
  }
  return lines.join("\n\n");
}

// Loads the latest memory, runs compact with the session transcript, and saves.
// Fire-and-forget safe: errors are logged but do not propagate.
export async function compactAndSave(
  chatId:     string,
  senderId:   string,
  senderName: string,
  messages:   Message[],
): Promise<void> {
  const session = formatSessionTranscript(messages);
  if (session.trim().length < 50) return;

  const [existingChat, existingUser] = await Promise.all([
    getChatMemory(chatId).catch(() => null),
    getUserMemory(senderId).catch(() => null),
  ]);

  await Promise.all([
    chat(
      buildMessages(COMPACT_CHAT_PROMPT, { existing: existingChat ?? "（无）", session }),
      { temperature: 0.3, maxTokens: 700 },
    )
      .then(m => saveChatMemory(chatId, m))
      .catch(e => console.error("[memory] chat compact error:", e)),

    chat(
      buildMessages(COMPACT_USER_PROMPT, { existing: existingUser ?? "（无）", senderName, session }),
      { temperature: 0.3, maxTokens: 450 },
    )
      .then(m => saveUserMemory(senderId, m))
      .catch(e => console.error("[memory] user compact error:", e)),
  ]);
}
