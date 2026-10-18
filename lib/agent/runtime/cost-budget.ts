import { createHash } from "node:crypto";
import type { Context, Model, SimpleStreamOptions } from "../../../vendor/openclaw/packages/llm-core/src/types";
import { creditsFromUsd } from "@/lib/account/plan";
import { estimateRequestBudget } from "./context-budget";
import { usdOfTokens } from "./billing";

// 最终上限与正常任务预算分开：预算覆盖 12 次冷缓存往返，并留在美元上限内。
// 缓存命中只能降低实际支出，不能成为允许发起请求的前提。
const costLimitUsd = Number(process.env.AI_TASK_COST_LIMIT_USD ?? 10);
if (!Number.isFinite(costLimitUsd) || costLimitUsd <= 0) throw new Error("AI_TASK_COST_LIMIT_USD 必须是正数");
export const TASK_COST_LIMIT_CREDITS = creditsFromUsd(costLimitUsd);
const MIN_TASK_CREDITS = creditsFromUsd(0.22);
export const TASK_REQUEST_ALLOWANCE = 12;
export function estimateCostBudget(model: Model, context: Context, options?: Pick<SimpleStreamOptions, "maxTokens">, calibration = 1) {
  const request = estimateRequestBudget(model, context, options, calibration);
  const requestCredits = Math.max(1, creditsFromUsd(usdOfTokens({ input: request.estimatedInputTokens, output: request.outputReserveTokens, cacheRead: 0 }, model)));
  return {
    requestCredits,
    taskCredits: Math.min(TASK_COST_LIMIT_CREDITS, Math.max(MIN_TASK_CREDITS, requestCredits * TASK_REQUEST_ALLOWANCE)),
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
/** 只存摘要，不把参数或工具正文复制到诊断表。结果变化视为进展。 */
export function toolProgressKey(name: string, args: unknown, result: unknown): string {
  const visibleResult = result && typeof result === "object" && "content" in result
    ? { content: result.content, isError: "isError" in result ? result.isError : false }
    : result;
  return createHash("sha256").update(JSON.stringify(canonical([name, args, visibleResult]))).digest("hex");
}
/** 检查已完成调用的尾部：同一步重复四次，或 2–4 步循环重复三次。 */
export function repeatsWithoutProgress(keys: string[]): boolean {
  if (keys.length >= 4 && new Set(keys.slice(-4)).size === 1) return true;
  for (let width = 2; width <= 4; width++) {
    if (keys.length < width * 3) continue;
    const tail = keys.slice(-width * 3);
    if (tail.every((key, index) => key === tail[index % width])) return true;
  }
  return false;
}

/** 参数校验和权限门拒绝也会形成工具结果，但不会进入工具 execute 包装。 */
export function contextRepeatsWithoutProgress(messages: Context["messages"]): boolean {
  const calls = new Map<string, { name: string; arguments: unknown }>();
  const keys: string[] = [];
  for (const message of messages) {
    if (message.role === "user") { calls.clear(); keys.length = 0; }
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, part);
    }
    if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId);
      if (call) keys.push(toolProgressKey(call.name,call.arguments,message));
    }
  }
  return repeatsWithoutProgress(keys.slice(-12));
}
