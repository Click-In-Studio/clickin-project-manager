import type {
  Context,
  Model,
  SimpleStreamOptions,
} from "../../../vendor/openclaw/packages/llm-core/src/types";
import type { CompactionSettings } from "../../../vendor/openclaw/packages/agent-core/src/harness/compaction/compaction";
import { normalOutputTokens } from "./config";
import { imageTokens, mediaBudget, nativeCapability, requestMedia } from "./media-budget";

export const CONTEXT_PRESSURE_RATIO = 0.8;
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) <= 127) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other);
}
export function requestOutputTokens(
  model: Model,
  options?: Pick<SimpleStreamOptions, "maxTokens">,
): number {
  return Math.min(options?.maxTokens ?? normalOutputTokens(model), model.maxTokens);
}
export function estimateRequestBudget(
  model: Model,
  context: Context,
  options?: Pick<SimpleStreamOptions, "maxTokens">,
  calibration = 1,
) {
  let mediaTokens = 0;
  let mediaCount = 0;
  // 原件字节与 base64 单独限制，不能冒充普通文本 token。
  const messages = context.messages.map((message) => {
    if (message.role === "assistant" || !Array.isArray(message.content))
      return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type === "text") return part;
        if (
          !part.budget ||
          !Number.isFinite(part.budget.estimatedTokens) ||
          part.budget.estimatedTokens < 0
        )
          throw new Error("媒体缺少已测量预算，不能按文件名估算后请求");
        const capability = part.type === "image" ? nativeCapability(model, part.mimeType, "image") : undefined;
        mediaTokens += capability && part.budget.width && part.budget.height
          ? imageTokens(capability, part.budget.width, part.budget.height) : part.budget.estimatedTokens;
        mediaCount++;
        return { type: part.type, mimeType: part.mimeType };
      }),
    };
  });
  const text = JSON.stringify(messages);
  const systemTokens = estimateTextTokens(context.systemPrompt ?? "");
  const toolTokens = estimateTextTokens(JSON.stringify(context.tools ?? []));
  const messageTokens = estimateTextTokens(text);
  const heuristicTokens =
    systemTokens + toolTokens + messageTokens + mediaTokens;
  const estimatedInputTokens = Math.ceil(
    heuristicTokens * Math.max(1, calibration),
  );
  const effectiveContextWindow = Math.min(
    model.contextWindow,
    model.contextTokens ?? model.contextWindow,
  );
  const outputReserveTokens = requestOutputTokens(model, options);
  const pressureThreshold = Math.min(
    Math.floor(effectiveContextWindow * CONTEXT_PRESSURE_RATIO),
    effectiveContextWindow - outputReserveTokens,
  );
  const media = mediaBudget(model, requestMedia(context.messages));
  // 原件 base64 与文字、工具定义合计；JSON 元数据也计入，发送边界再检查真实序列化体积。
  const estimatedRequestBytes = Buffer.byteLength(JSON.stringify({ systemPrompt: context.systemPrompt, tools: context.tools, messages }))
    + media.base64Chars;
  const requestFits = model.maxRequestBytes === undefined || estimatedRequestBytes <= model.maxRequestBytes;
  const textFits = estimatedInputTokens + outputReserveTokens <= effectiveContextWindow;
  return {
    systemTokens,
    toolTokens,
    requestShapeTokens: heuristicTokens,
    messageTokens,
    mediaTokens,
    mediaCount,
    heuristicTokens,
    estimatedInputTokens,
    effectiveContextWindow,
    outputReserveTokens,
    pressureThreshold,
    pressured: estimatedInputTokens >= pressureThreshold,
    textFits,
    mediaFits: media.fits,
    mediaReasons: media.reasons,
    estimatedRequestBytes,
    requestFits,
    fits: textFits && media.fits && requestFits,
    basis:
      calibration > 1
        ? "文本字符及实测模态预算；本 run 已发送请求的 provider input usage 校准"
        : "文本字符及实测模态预算；未获得本 run provider 校准",
  };
}
export function compactionSettingsFor(
  model: Model,
  options?: Pick<SimpleStreamOptions, "maxTokens">,
  forced = false,
): CompactionSettings {
  const window = Math.min(
    model.contextWindow,
    model.contextTokens ?? model.contextWindow,
  );
  // 摘要预算不随普通回复上限放大，避免一次输出修复改变摘要与近期原文保留量。
  const reserveTokens = Math.min(
    Math.min(8_192, requestOutputTokens(model, options)),
    Math.floor(window / 4),
  );
  return {
    enabled: true,
    reserveTokens,
    keepRecentTokens: forced
      ? 0
      : Math.min(Math.floor(window * 0.2), reserveTokens),
  };
}

export const MAX_CONTEXT_OVERFLOW_RETRIES = 1;
