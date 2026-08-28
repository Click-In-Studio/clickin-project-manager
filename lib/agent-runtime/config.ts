// 自建运行时的模型与开关（#367 S2）。
//
// 模型事实（线上）：对话 deepseek-v4-flash；transcript compaction 摘要用 deepseek-v4-pro
// （与记忆蒸馏同理：长上下文可靠度优先，低频可承受，§10-6 定谳）。
//
// ⚠ compat.maxTokensField 必须显式 "max_tokens"：@openclaw/ai 2026.7.1-2 对 deepseek
// 自动选 max_completion_tokens，DeepSeek API 忽略它 → 输出永不封顶（S1 实测：上限 16
// 照样产出 600 字）。见 tests/agent-runtime-live.test.ts。

import { createApiRegistry, createLlmRuntime, type LlmRuntime } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import type { Model } from "../../vendor/openclaw/packages/llm-core/src/types.js";
import { productionIdOfSessionKey } from "@/lib/agent-gateway/client";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

function deepseekModel(id: string, reasoning: boolean): Model {
  return {
    id, name: id, api: "openai-completions", provider: "deepseek",
    baseUrl: DEEPSEEK_BASE_URL, reasoning, input: ["text"],
    // 成本字段只用于 agent-core 的 usage.cost 估算；记账以 token 数为准（ai_usage）
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
// AGENT_RUNTIME = gateway（默认，全走网关）| runner（全走自建）| canary
// canary 时 AGENT_RUNTIME_PRODUCTIONS = 逗号分隔的 production id；个人会话（无
// production）在 canary 下按 AGENT_RUNTIME_PERSONAL=1 决定。
export type RuntimeKind = "gateway" | "runner";

export function runtimeFor(sessionKey: string): RuntimeKind {
  const mode = process.env.AGENT_RUNTIME ?? "gateway";
  if (mode === "runner") return "runner";
  if (mode !== "canary") return "gateway";
  const productionId = productionIdOfSessionKey(sessionKey);
  if (!productionId) return process.env.AGENT_RUNTIME_PERSONAL === "1" ? "runner" : "gateway";
  const allow = (process.env.AGENT_RUNTIME_PRODUCTIONS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return allow.includes("*") || allow.includes(productionId) ? "runner" : "gateway";
}

/** 执行者标识（agent_run.owner）：主机 + pid，重启后自然变化。 */
export const RUNNER_OWNER = `${process.env.HOSTNAME ?? "local"}:${process.pid}`;
export const HEARTBEAT_INTERVAL_MS = Number(process.env.AGENT_HEARTBEAT_MS ?? 5_000);
export const ORPHAN_AFTER_MS = Number(process.env.AGENT_ORPHAN_AFTER_MS ?? 30_000);
export const APPROVAL_TTL_MS = Number(process.env.AGENT_APPROVAL_TTL_MS ?? 600_000);
