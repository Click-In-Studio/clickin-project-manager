import type { Context, Model } from "../../vendor/openclaw/packages/llm-core/src/types";
import { hiddenModelCandidates, llmRuntime, modelApiKey } from "./runtime/config";

export type Message = { role: "system" | "user"; content: string };
export type ChatOptions<T> = {
  purpose: string;
  maxTokens: number;
  temperature?: number;
  parse: (raw: string) => T;
};
export type ChatResult<T> = { value: T; provider: string; model: string };
export const HIDDEN_MODEL_POLICY = "hidden-v1:deepseek-flash>qwen3.8-flash";
const COOLDOWN_MS = 60_000;
const TOTAL_TIMEOUT_MS = 35_000;
// 只影响隐藏调用；主聊天继续尊重用户选择。每个服务进程各自记录故障。
const unavailableUntil = new Map<string, number>();

export class LlmBudgetError extends Error {
  constructor(message: string, readonly truncated: boolean) {
    super(message);
    this.name = "LlmBudgetError";
  }
}
export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}
class OutputError extends Error {}
class ProviderError extends Error {}

function contextOf(messages: Message[]): Context {
  return {
    systemPrompt: messages.filter(m => m.role === "system").map(m => m.content).join("\n\n"),
    messages: messages.filter(m => m.role === "user").map(m => ({
      role: "user" as const, content: m.content, timestamp: Date.now(),
    })),
  };
}

async function attempt<T>(model: Model, context: Context, options: ChatOptions<T>, timeoutMs: number): Promise<ChatResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status: number | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new ProviderError("模型请求超时"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    let apiKey: string;
    try { apiKey = modelApiKey(model); } catch { throw new ProviderError("模型凭据未配置"); }
    const response = await Promise.race([
      llmRuntime().completeSimple(model, context, {
        apiKey, signal: controller.signal, timeoutMs, maxRetries: 0,
        maxTokens: options.maxTokens, temperature: options.temperature ?? 0,
        onResponse: response => { status = response.status; },
      }),
      aborted,
    ]);
    if ((status && status >= 400) || response.stopReason === "error" || response.stopReason === "aborted")
      throw new ProviderError(`供应商请求失败${status ? ` HTTP ${status}` : ""}`);
    if (response.stopReason === "length") throw new LlmBudgetError("模型输出超出预算", true);
    const raw = response.content.filter(part => part.type === "text").map(part => part.text).join("").trim();
    if (!raw) throw new OutputError("模型输出为空");
    let value: T;
    try { value = options.parse(raw); } catch { throw new OutputError("模型输出未通过业务校验"); }
    return { value, provider: model.provider, model: model.id };
  } catch (error) {
    if (error instanceof ProviderError || error instanceof OutputError || error instanceof LlmBudgetError) throw error;
    throw new ProviderError(status ? `供应商请求失败 HTTP ${status}` : "供应商网络或请求异常");
  } finally {
    clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

/** 只重试无副作用的生成与校验；调用方在成功后单独提交业务事务。 */
export async function chat<T>(messages: Message[], options: ChatOptions<T>): Promise<ChatResult<T>> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const context = contextOf(messages);
  const failures: Error[] = [];
  const candidates = hiddenModelCandidates();
  for (const model of candidates) {
    if ((unavailableUntil.get(model.provider) ?? 0) > Date.now()) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const started = Date.now();
    try {
      const result = await attempt(model, context, options, Math.min(remaining, model.provider === "deepseek" ? 12_000 : 20_000));
      unavailableUntil.delete(model.provider);
      console.info("[hidden-llm]", { purpose: options.purpose, provider: model.provider, model: model.id, outcome: "success", elapsedMs: Date.now() - started });
      return result;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("供应商请求异常");
      failures.push(failure);
      const kind = failure instanceof LlmBudgetError ? "budget" : failure instanceof OutputError ? "invalid_output" : "provider_unavailable";
      if (kind === "provider_unavailable") unavailableUntil.set(model.provider, Date.now() + COOLDOWN_MS);
      // 不记录正文、凭据或供应商原始响应；配置错误与故障接替仍需可见。
      console.warn("[hidden-llm]", { purpose: options.purpose, provider: model.provider, model: model.id, outcome: kind, elapsedMs: Date.now() - started, error: failure.message });
    }
  }
  // 必须所有候选都明确是预算问题，才能允许蒸馏缩小输入或跳过材料。
  if (failures.length === candidates.length && failures.every(error => error instanceof LlmBudgetError))
    throw new LlmBudgetError("全部备选模型输出超出预算", true);
  throw new LlmUnavailableError("智能处理服务暂不可用，请稍后重试");
}
