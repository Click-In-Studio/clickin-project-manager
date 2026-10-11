import type { Context, Model, SimpleStreamOptions } from "../../../vendor/openclaw/packages/llm-core/src/types";
import type { AgentMessage } from "../../../vendor/openclaw/packages/agent-core/src/types";
import { estimateContextTokens } from "../../../vendor/openclaw/packages/agent-core/src/harness/compaction/compaction";

export const CONTEXT_PRESSURE_RATIO = 0.8;
export const MAX_CONTEXT_OVERFLOW_RETRIES = 1;

function json(value: unknown): string {
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
}

/** ASCII 约 4 字符/token；中文等非 ASCII 文本按 1 字符/token 保守估算。 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4 + nonAscii);
}

export interface RequestBudget {
  estimatedInputTokens: number;
  messageTokens: number;
  requestShapeTokens: number;
  systemTokens: number;
  toolTokens: number;
  outputReserveTokens: number;
  effectiveContextWindow: number;
  pressureThreshold: number;
  pressured: boolean;
}

/**
 * 预算按即将发送的完整请求计算。最近一次 provider usage 负责校准历史消息，
 * 当前 system、工具定义和临时插入仍逐次重算，避免工具面变化后沿用旧快照。
 */
export function estimateRequestBudget(
  model: Model,
  context: Context,
  options?: Pick<SimpleStreamOptions, "maxTokens">,
): RequestBudget {
  const messageEstimate = estimateContextTokens(context.messages as AgentMessage[]).tokens;
  const systemTokens = estimateTextTokens(context.systemPrompt ?? "");
  const toolTokens = estimateTextTokens(json(context.tools ?? []));
  const requestShapeTokens = systemTokens
    + toolTokens
    + estimateTextTokens(json(context.messages));
  // provider usage 已包含上一请求的 system / tools；再加当前静态面会偏保守，
  // 但能确保重启恢复时工具或指令变化不会低估。完整请求启发式提供独立下界。
  const estimatedInputTokens = Math.max(
    requestShapeTokens,
    messageEstimate + systemTokens + toolTokens,
  );
  const effectiveContextWindow = model.contextTokens ?? model.contextWindow;
  const outputReserveTokens = options?.maxTokens ?? model.maxTokens;
  const pressureThreshold = Math.min(
    Math.floor(effectiveContextWindow * CONTEXT_PRESSURE_RATIO),
    Math.max(1, effectiveContextWindow - outputReserveTokens),
  );
  return {
    estimatedInputTokens,
    messageTokens: messageEstimate,
    requestShapeTokens,
    systemTokens,
    toolTokens,
    outputReserveTokens,
    effectiveContextWindow,
    pressureThreshold,
    pressured: estimatedInputTokens >= pressureThreshold,
  };
}
