// 自建运行时的模型与开关（#367 S2）。
//
// 模型事实（线上）：对话 deepseek-v4-flash；transcript compaction 摘要用 deepseek-v4-pro
// （与记忆蒸馏同理：长上下文可靠度优先，低频可承受，§10-6 定谳）。
//
// ⚠ Model.cost 不再是装饰（#383）：限流的 credit 折算就从 provider 层算出的
// usage.cost 来。加新模型必须同时登记单价，否则它的用量记 0 credit = 白嫖。
//
// ⚠ compat.maxTokensField 必须显式 "max_tokens"：@openclaw/ai 2026.7.1-2 对 deepseek
// 自动选 max_completion_tokens，DeepSeek API 忽略它 → 输出永不封顶（S1 实测：上限 16
// 照样产出 600 字）。见 tests/agent-runtime-live.test.ts。

import { createApiRegistry, createLlmRuntime, type LlmRuntime } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import type { Model } from "../../vendor/openclaw/packages/llm-core/src/types";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

// DeepSeek 官方价目（$/1M token，**peak 价**）。off-peak 是半价，我们一律按 peak
// 记——保守，实际账单只会比记的低。限流的 credit 折算就吃这张表：provider 层
// （@openclaw/ai model-utils）用 Model.cost 逐条算出 usage.cost，service.ts 把
// 美元数交给 lib/plan.ts 折成 credit。**填 0 等于所有 chat 用量记 0 credit**。
const PRICES = {
  "v4-flash": { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
  "v4-pro":   { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
} as const;

/** 未登记的模型 id 按 pro 价记（贵的那档）：宁可高估也不要静默记 0。 */
function priceOf(id: string): Model["cost"] {
  return id.includes("flash") ? { ...PRICES["v4-flash"] } : { ...PRICES["v4-pro"] };
}

function deepseekModel(id: string, reasoning: boolean): Model {
  return {
    id, name: id, api: "openai-completions", provider: "deepseek",
    baseUrl: DEEPSEEK_BASE_URL, reasoning, input: ["text"],
    cost: priceOf(id),
    contextWindow: 128_000,
    maxTokens: 8_192,
    compat: { maxTokensField: "max_tokens" } as Model["compat"],
  };
}

export const CHAT_MODEL: Model = deepseekModel(process.env.AGENT_CHAT_MODEL ?? "deepseek-v4-flash", false);
export const COMPACTION_MODEL: Model = deepseekModel(process.env.AGENT_COMPACTION_MODEL ?? "deepseek-v4-pro", true);

export function deepseekApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw Object.assign(new Error("DEEPSEEK_API_KEY 未配置"), { status: 503 });
  return key;
}

let runtime: LlmRuntime | undefined;
/** 进程级单例：provider 注册表 + streamSimple/completeSimple。 */
export function llmRuntime(): LlmRuntime {
  if (!runtime) {
    const registry = createApiRegistry();
    registerBuiltInApiProviders(registry);
    runtime = createLlmRuntime(registry);
  }
  return runtime;
}

// ── 灰度开关（§4.5：按 production）───────────────────────────────────────────

/** 执行者标识（agent_run.owner）：主机 + pid，重启后自然变化。 */
export const RUNNER_OWNER = `${process.env.HOSTNAME ?? "local"}:${process.pid}`;
export const HEARTBEAT_INTERVAL_MS = Number(process.env.AGENT_HEARTBEAT_MS ?? 5_000);
export const ORPHAN_AFTER_MS = Number(process.env.AGENT_ORPHAN_AFTER_MS ?? 30_000);
export const APPROVAL_TTL_MS = Number(process.env.AGENT_APPROVAL_TTL_MS ?? 600_000);
