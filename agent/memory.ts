import type { Message } from "./llm";
import { chat } from "./llm";
import { buildMessages } from "./prompt";
import { getChatMemory, getUserMemory, saveChatMemory, saveUserMemory } from "./db";
import { COMPACT_CHAT_PROMPT } from "./prompts/_compact-chat";
import { COMPACT_USER_PROMPT } from "./prompts/_compact-user";
import type { HistoryMessage } from "./types";

// ── Structured memory types ────────────────────────────────────────────────────

export type MemoryData = {
  preferences: string[];  // preferences, habits, communication style
  topics:      string[];  // recent topics and conclusions
  workflow:    string[];  // workflow patterns, skill usage habits
  knowledge:   string[];  // user-provided external knowledge/context
  questions:   string[];  // unresolved questions
};

export type MemoryContext = {
  chatMemory: string;
  userMemory: string;
};

const EMPTY_MEMORY: MemoryData = {
  preferences: [], topics: [], workflow: [], knowledge: [], questions: [],
};

function parseMemory(raw: string): MemoryData | null {
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();
    const d = JSON.parse(cleaned) as Partial<Record<keyof MemoryData, unknown>>;
    const toStringArray = (v: unknown): string[] =>
      Array.isArray(v) ? (v as unknown[]).filter((s): s is string => typeof s === "string") : [];
    return {
      preferences: toStringArray(d.preferences),
      topics:      toStringArray(d.topics),
      workflow:    toStringArray(d.workflow),
      knowledge:   toStringArray(d.knowledge),
      questions:   toStringArray(d.questions),
    };
  } catch {
    return null;
  }
}

function isEmptyData(d: MemoryData): boolean {
  return d.preferences.length === 0 && d.topics.length === 0 &&
         d.workflow.length === 0 && d.knowledge.length === 0 && d.questions.length === 0;
}

const LABELS: Record<keyof MemoryData, string> = {
  preferences: "偏好/习惯",
  topics:      "近期话题",
  workflow:    "工作流",
  knowledge:   "背景知识",
  questions:   "待解问题",
};

function formatForPrompt(d: MemoryData): string {
  const parts: string[] = [];
  for (const key of Object.keys(LABELS) as (keyof MemoryData)[]) {
    if (d[key].length > 0) {
      parts.push(`**${LABELS[key]}**: ${d[key].join("；")}`);
    }
  }
  return parts.length > 0 ? parts.join("\n") : "（无）";
}

const HISTORY_DIGEST_SIZE = 6;

// Returns a sanitised summary of recent chat history for injection into the base prompt.
// Strips specific data values so the agent cannot treat past replies as ground truth.
// The raw history remains accessible via the get_history skill.
export async function digestHistory(history: HistoryMessage[]): Promise<string> {
  if (history.length === 0) return "（无）";

  const recent = history.slice(0, HISTORY_DIGEST_SIZE).reverse();
  const raw = recent.map(m => {
    const who  = m.senderType === "app" ? "助手" : m.senderName;
    const body = m.type === "text" ? (m.text ?? "").slice(0, 400)
               : m.type === "card" ? `[卡片: ${m.cardTitle ?? ""}]`
               : "[其他]";
    return `${who}: ${body}`;
  }).join("\n");

  return chat(
    [
      {
        role: "system",
        content: `将飞书聊天记录转写为抽象意图描述。规则：
1. 每条消息只描述"做了什么类型的操作"，不包含任何具体值
2. 所有人名（无论用户还是助手）→ [某用户] / [助手]
3. 所有时间（几点、几分、日期）→ [某时间]
4. 所有地点 → [某地点]
5. 所有数字、ID → [某数值]
6. 所有事件/演出/剧目名称 → [某事件] / [某演出]
7. 所有具体内容（技术需求、报告正文等）→ [具体内容]

示例：
输入：王恺镔: 排练几点开始？
输出：[某用户] 询问了某事件的开始时间

输入：助手: 排练是10点，请11:15到场
输出：[助手] 确认了开始时间并告知了集合时间

如果没有实质内容，输出"（无实质历史记录）"。只输出转写结果，不加任何说明。`,
      },
      { role: "user", content: raw },
    ],
    { temperature: 0, maxTokens: 200 },
  ).catch(() => "（历史记录摘要失败）");
}

export async function loadMemory(chatId: string, senderId: string): Promise<MemoryContext> {
  const [chatRaw, userRaw] = await Promise.all([
    getChatMemory(chatId).catch(() => null),
    getUserMemory(senderId).catch(() => null),
  ]);
  return {
    chatMemory: formatForPrompt(chatRaw ? (parseMemory(chatRaw) ?? EMPTY_MEMORY) : EMPTY_MEMORY),
    userMemory: formatForPrompt(userRaw ? (parseMemory(userRaw) ?? EMPTY_MEMORY) : EMPTY_MEMORY),
  };
}

function formatSessionTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content.startsWith("系统通知")) {
        lines.push(`[系统通知]: ${m.content}`);
      } else if (m.content.startsWith("技能")) {
        // Strip actual result content — only record which skill ran and whether it failed
        const nameMatch = m.content.match(/^技能 "([^"]+)"/);
        const skillName = nameMatch ? nameMatch[1] : "未知";
        const failed = m.content.includes("执行失败");
        lines.push(`[系统]: 技能 "${skillName}" ${failed ? "执行失败" : "执行完毕"}（结果内容已脱敏）`);
      }
      // skip all other system messages (base prompt boilerplate etc.)
    } else if (m.role === "assistant") {
      try {
        const p = JSON.parse(m.content) as { skill: string; reason: string };
        lines.push(`[助手] 调用技能=${p.skill} reason=${p.reason}`);
      } catch {
        lines.push(`[助手]: ${m.content.slice(0, 300)}`);
      }
    } else {
      lines.push(`[用户]: ${m.content}`);
    }
  }
  return lines.join("\n\n");
}

export async function compactAndSave(
  chatId:     string,
  senderId:   string,
  senderName: string,
  messages:   Message[],
): Promise<void> {
  const session = formatSessionTranscript(messages);
  if (!messages.some(m => m.role === "user")) return;

  const [existingChatRaw, existingUserRaw] = await Promise.all([
    getChatMemory(chatId).catch(() => null),
    getUserMemory(senderId).catch(() => null),
  ]);

  // Pass existing as JSON string so the LLM can merge it; fall back to empty structure
  const existingChat = existingChatRaw ?? JSON.stringify(EMPTY_MEMORY);
  const existingUser = existingUserRaw ?? JSON.stringify(EMPTY_MEMORY);

  await Promise.all([
    chat(
      buildMessages(COMPACT_CHAT_PROMPT, { existing: existingChat, session }),
      { temperature: 0.3, maxTokens: 600 },
    )
      .then(raw => {
        const parsed = parseMemory(raw);
        if (!parsed) {
          console.warn(`[memory] chat compact: invalid JSON output, skipping. raw=${raw.slice(0, 200)}`);
          return;
        }
        if (isEmptyData(parsed)) {
          console.log(`[memory] chat compact skipped (all empty) chatId=${chatId}`);
          return;
        }
        return saveChatMemory(chatId, JSON.stringify(parsed)).then(() => {
          console.log(`[memory] chat compact saved (chatId=${chatId}):`, parsed);
        });
      })
      .catch(e => console.error("[memory] chat compact error:", e)),

    chat(
      buildMessages(COMPACT_USER_PROMPT, { existing: existingUser, senderName, session }),
      { temperature: 0.3, maxTokens: 400 },
    )
      .then(raw => {
        const parsed = parseMemory(raw);
        if (!parsed) {
          console.warn(`[memory] user compact: invalid JSON output, skipping. raw=${raw.slice(0, 200)}`);
          return;
        }
        if (isEmptyData(parsed)) {
          console.log(`[memory] user compact skipped (all empty) senderId=${senderId}`);
          return;
        }
        return saveUserMemory(senderId, JSON.stringify(parsed)).then(() => {
          console.log(`[memory] user compact saved (senderId=${senderId}):`, parsed);
        });
      })
      .catch(e => console.error("[memory] user compact error:", e)),
  ]);
}
