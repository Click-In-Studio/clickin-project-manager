// 个人记忆蒸馏管线：episodic（runs.jsonl 增量）+ 现有 MEMORY.md
// → LLM consolidation → 新 MEMORY.md。
//
// 触发：/api/internal/memory-distill（服务器 crontab 定时打，建议每日一次）。
// LLM 走 agent/llm.ts（OpenAI-compatible，LLM_PROVIDER=deepseek/openai）。
// 团队记忆（Phase B）将作为本管线的第二个输出目标扩展（内容级安全 gate）。

import { chat, LlmBudgetError } from "@/lib/llm-chat";
import { commitDistill, listUserIds, readMemory, readRunsSinceLastDistill, writeMemory, type RunRecord } from "./store";

const CURRENT_MEMORY_MAX_CHARS = 8_000;

/**
 * 单次蒸馏消费的 episodic 上限，从大往小退。
 *
 * 输出预算有模型上限（8K），输入没有——所以撞上"预算不够"时唯一能降的是输入。
 * 若只在输出侧硬顶，某轮注定超预算的批次会天天以同样的方式失败、offset 永不
 * 推进（commitDistill 只在成功后跑），这个用户的记忆就永久停更了。
 * 逐档缩小则每轮都能吃下一部分，积压慢慢消化。
 *
 * 末档 1：store.readRunsSinceLastDistill 保证"至少消费一条"，所以最后一档
 * 恒等于"只喂一条"，是能推进偏移的最小单位。
 */
const DISTILL_INPUT_STEPS = [24_000, 12_000, 6_000, 3_000, 1] as const;

const SYSTEM_PROMPT = `你是 Click-In 演艺制作平台 AI 助手的记忆整理器。任务：把用户既有的长期记忆摘要与新增对话记录合并，输出**新的完整长期记忆摘要**（Markdown）。

规则：
- 只保留对后续协作有持续价值的内容：用户的偏好与工作习惯、进行中的项目/事项及其状态、重要决策与结论、明确的待办
- 丢弃：寒暄闲聊、一次性问答、系统测试内容、已完结且无后续价值的事项
- 新信息与旧记忆冲突时**就地改写该条目取代旧说法**，绝不新旧并列（并列会导致后续按旧值回答）；旧记忆中仍有效的条目要保留
- 用简洁的中文要点组织（每条一行、以 - 开头），可分「偏好与习惯」「进行中的事项」「重要结论」等小节；小节标题用**三级标题（### ）或加粗行**，不要使用一级/二级标题（# / ##）——摘要会被嵌进上层文档结构

每条要点的行尾注释元数据（供检索索引使用，格式必须严格一致）：
- 每条要点行尾附重要性评分：\`<!-- importance: n -->\`，n 为 1-10 整数——衡量该条对后续协作的持续价值（10=核心偏好/长期项目，1=边缘信息）
- 仅当条目有明确的触发场景（"聊到什么话题时该想起它"）才附：\`<!-- trigger: 短语1, 短语2 -->\`，短语用逗号分隔、每条最多 3 个短语；没有明确场景就不要附
- 示例：\`- 排练通告默认下午 2 点发出 <!-- trigger: 排练通告, 通告时间 --> <!-- importance: 7 -->\`

- 正文总长度（不含行尾注释）不超过 3000 字符
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

export type DistillResult = {
  userId: string;
  /** skipped = 单条记录都超预算，跳过它以免永久堵住该用户后续蒸馏。 */
  status: "distilled" | "no-new-data" | "error" | "skipped";
  entries?: number;
  /** 实际生效的输入档位（诊断用）。 */
  inputChars?: number;
  /** 是否降过档才成功。由本模块判定——档位表在这里，别让调用方拿常量比对。 */
  shrunk?: boolean;
  error?: string;
};

export async function distillUser(userId: string): Promise<DistillResult> {
  try {
    const current = readMemory(userId, CURRENT_MEMORY_MAX_CHARS);

    for (let i = 0; i < DISTILL_INPUT_STEPS.length; i++) {
      const maxChars = DISTILL_INPUT_STEPS[i];
      const isLastStep = i === DISTILL_INPUT_STEPS.length - 1;
      // 每档都从**同一个 offset** 重读（上一档没成功就没 commit），只是少喂一些
      const { entries, nextOffset } = readRunsSinceLastDistill(userId, maxChars);
      if (entries.length === 0) return { userId, status: "no-new-data" };

      const userPrompt = [
        current ? `【现有长期记忆摘要】\n${current}` : "【现有长期记忆摘要】\n（尚无）",
        `【新增对话记录】\n${formatEntries(entries)}`,
      ].join("\n\n");

      try {
        // rejectTruncated：输出会**覆盖** MEMORY.md，半截摘要写进去等于把长期
        // 记忆换成残文。maxTokens 直接给上限：推理模型上它是 CoT+正文的总预算，
        // 按正文估会被思维链吃光（线上 deepseek-v4-pro 实测 CoT 占 94%）。
        const next = await chat(
          [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          { maxTokens: 8000, temperature: 0.3, rejectTruncated: true },
        );

        writeMemory(userId, next.trim());
        commitDistill(userId, nextOffset);
        // curated 重建检索索引：蒸馏是离线批处理，可以等；但索引失败不算
        // 蒸馏失败（记忆文件已落盘是事实，索引可由回填脚本补）
        try {
          const { indexCurated } = await import("./index-db");
          await indexCurated("user", userId, next.trim());
        } catch (err) {
          console.error(`[distill] ${userId} curated 索引重建失败（蒸馏本身已成功）:`, err);
        }
        return {
          userId, status: "distilled", entries: entries.length,
          inputChars: maxChars, shrunk: i > 0,
        };
      } catch (err) {
        if (!(err instanceof LlmBudgetError)) throw err;

        if (!isLastStep) {
          console.warn(
            `[distill] ${userId} 在 ${maxChars} 字符档超预算（${err.message}），降档重试`,
          );
          continue;
        }
        // 末档 = 只喂一条仍超预算：这条记录本身有毒。推进偏移把它跳过——
        // 不跳的话它会永远堵住这个用户之后的全部蒸馏（offset 停在它前面）。
        // 代价是这条 episodic 不进长期记忆，记在日志里以便追查。
        console.error(
          `[distill] ${userId} 单条记录仍超预算，跳过并推进偏移至 ${nextOffset}：${err.message}`,
        );
        commitDistill(userId, nextOffset);
        return {
          userId, status: "skipped", entries: entries.length, inputChars: maxChars,
          shrunk: true, error: err.message,
        };
      }
    }

    return { userId, status: "no-new-data" };
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
