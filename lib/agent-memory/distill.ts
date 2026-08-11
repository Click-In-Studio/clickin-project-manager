// 个人记忆蒸馏管线：episodic（runs.jsonl 增量）+ 现有 MEMORY.md
// → LLM consolidation → 新 MEMORY.md。
//
// 触发：/api/internal/memory-distill（服务器 crontab 定时打，建议每日一次）。
// LLM 走 agent/llm.ts（OpenAI-compatible，LLM_PROVIDER=deepseek/openai）。
// 团队记忆（Phase B）将作为本管线的第二个输出目标扩展（内容级安全 gate）。

import { chat } from "@/agent/llm";
import { commitDistill, listUserIds, readMemory, readRunsSinceLastDistill, writeMemory, type RunRecord } from "./store";

const DISTILL_INPUT_MAX_CHARS = 24_000; // 单次蒸馏消费的 episodic 上限，超出留到下次
const CURRENT_MEMORY_MAX_CHARS = 8_000;

const SYSTEM_PROMPT = `你是 Click-In 演艺制作平台 AI 助手的记忆整理器。任务：把用户既有的长期记忆摘要与新增对话记录合并，输出**新的完整长期记忆摘要**（Markdown）。

规则：
- 只保留对后续协作有持续价值的内容：用户的偏好与工作习惯、进行中的项目/事项及其状态、重要决策与结论、明确的待办
- 丢弃：寒暄闲聊、一次性问答、系统测试内容、已完结且无后续价值的事项
- 新信息与旧记忆冲突时以新为准；旧记忆中仍有效的条目要保留
- 用简洁的中文要点组织，可分「偏好与习惯」「进行中的事项」「重要结论」等小节；小节标题用**三级标题（### ）或加粗行**，不要使用一级/二级标题（# / ##）——摘要会被嵌进上层文档结构
- 总长度不超过 3000 字符
- 直接输出摘要正文，不要任何解释或前后缀`;

function formatEntries(entries: RunRecord[]): string {
  return entries
    .map((r) => {
      const when = r.ts?.slice(0, 16).replace("T", " ") ?? "";
      const prod = r.productionId ? `（制作 ${r.productionId}）` : "";
      return `[${when}]${prod}\n用户：${r.lastUser ?? "（无）"}\n助手：${r.lastAssistant ?? "（无）"}`;
    })
    .join("\n---\n");
}

export type DistillResult = { userId: string; status: "distilled" | "no-new-data" | "error"; entries?: number; error?: string };

export async function distillUser(userId: string): Promise<DistillResult> {
  try {
    const { entries, nextOffset } = readRunsSinceLastDistill(userId, DISTILL_INPUT_MAX_CHARS);
    if (entries.length === 0) return { userId, status: "no-new-data" };

    const current = readMemory(userId, CURRENT_MEMORY_MAX_CHARS);
    const userPrompt = [
      current ? `【现有长期记忆摘要】\n${current}` : "【现有长期记忆摘要】\n（尚无）",
      `【新增对话记录】\n${formatEntries(entries)}`,
    ].join("\n\n");

    const next = await chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      { maxTokens: 2000, temperature: 0.3 },
    );

    writeMemory(userId, next.trim());
    commitDistill(userId, nextOffset);
    return { userId, status: "distilled", entries: entries.length };
  } catch (err) {
    return { userId, status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/** 串行蒸馏全部用户（单用户失败不中断整批）。 */
export async function distillAllUsers(): Promise<DistillResult[]> {
  const results: DistillResult[] = [];
  for (const userId of listUserIds()) {
    results.push(await distillUser(userId));
  }
  return results;
}
