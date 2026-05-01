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

// Skills whose results are real DB/system data — should be preserved rather than stripped.
const DATA_SKILLS = new Set([
  "query_events", "get_event_detail", "get_daily_call", "get_weekly_call",
  "get_my_tech_reqs",
  "get_block_by_id", "get_block_by_line", "search_blocks", "query_blocks", "get_script_meta",
  "get_scenes", "get_characters", "get_productions",
  "get_history",
]);

// Returns a summary of recent Feishu chat history for injection into the base prompt.
// User messages are anonymised; bot messages are split into two categories:
//   - Messages that clearly relay system-queried data → preserved as-is
//   - Messages that are AI reasoning/inference → anonymised
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
        content: `将飞书聊天记录转写为上下文摘要，区分两类助手消息：

【助手消息分类规则】
- 如果助手在转述系统查询数据（包含具体时间、地点、人员列表、数字等可验证信息），视为"数据回复"，保留核心内容，标记为 [助手(数据)]: <保留内容>
- 如果助手在分析、推断或给出建议（无法从系统直接验证的内容），视为"推理回复"，抽象描述，标记为 [助手]: <意图描述>

【用户消息规则】（一律脱敏）
- 所有人名 → [某用户]
- 所有时间 → [某时间]
- 所有地点 → [某地点]
- 所有数字/ID → [某数值]
- 所有事件/演出名 → [某事件]
- 所有具体内容 → [具体内容]

示例：
输入：
王恺镔: 这周三排练几点开始？
助手: 根据系统数据，本周三排练为14:00，在第一排练厅，请11:45到场
王恺镔: 好的

输出：
[某用户] 询问了某活动的时间地点
[助手(数据)]: 本周三排练为14:00，在第一排练厅，请11:45到场
[某用户] 表示收到

如果没有实质内容，输出"（无实质历史记录）"。只输出转写结果，不加任何说明。`,
      },
      { role: "user", content: raw },
    ],
    { temperature: 0, maxTokens: 300 },
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

// Regex to extract skill name from a successful result message.
// Format: 以下是 "skillName" 的返回数据，仅供你决策下一步 action 使用。\n\n<result>\n\n<reminder>
const RE_SKILL_RESULT = /^以下是 "([^"]+)" 的返回数据/;
// Regex to extract skill name from a failure/no-result message.
const RE_SKILL_STATUS = /^技能 "([^"]+)"/;

function extractSkillResult(content: string): { skillName: string; result: string } | null {
  const m = content.match(RE_SKILL_RESULT);
  if (!m) return null;
  // Content is: header \n\n <result> \n\n <JSON_REMINDER>
  // Strip the first paragraph (header) and last paragraph (reminder)
  const parts = content.split("\n\n");
  const result = parts.slice(1, -1).join("\n\n").trim();
  return { skillName: m[1], result };
}

function formatSessionTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content.startsWith("系统通知")) {
        lines.push(`[系统通知]: ${m.content}`);
      } else {
        const extracted = extractSkillResult(m.content);
        if (extracted) {
          const { skillName, result } = extracted;
          if (DATA_SKILLS.has(skillName)) {
            // Preserve data-skill results verbatim so compact LLM can store facts
            lines.push(`[查询结果(${skillName})]: ${result}`);
          } else {
            lines.push(`[系统]: 技能 "${skillName}" 执行完毕`);
          }
        } else {
          // Failure / no-result messages: "技能 "X" 执行失败/已执行完毕…"
          const sm = m.content.match(RE_SKILL_STATUS);
          if (sm) {
            const failed = m.content.includes("执行失败");
            lines.push(`[系统]: 技能 "${sm[1]}" ${failed ? "执行失败" : "执行完毕"}`);
          }
          // All other system messages (base prompt boilerplate) are silently skipped
        }
      }
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
