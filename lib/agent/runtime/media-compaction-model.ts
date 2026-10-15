import type { AgentMessage } from "../../../vendor/openclaw/packages/agent-core/src/types";
import type { Context, Model } from "../../../vendor/openclaw/packages/llm-core/src/types";
import { modelCatalog } from "./model-settings-db";
import { modelApiKey, resolveModel } from "./config";
import { estimateRequestBudget } from "./context-budget";

/** 只在目标模型接不住旧媒体时使用实际承载过历史的模型，不扩大成通用自动故障切换。 */
export async function selectMediaCompactionModel(
  messages: AgentMessage[], context: Context, target: Model,
  userId: string, productionId: string | null, apiKeyOverride?: string,
): Promise<{ model: Model; apiKey: string }> {
  const catalog = await modelCatalog(userId, productionId);
  const eligible = catalog.filter((item) => item.available).map((item) => resolveModel(item.key));
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
    const model = eligible.find((item) => item.id === message.model && item.provider === message.provider);
    if (!model || model.id === target.id && model.provider === target.provider) continue;
    if (estimateRequestBudget(model, context).fits) return { model, apiKey: apiKeyOverride ?? modelApiKey(model) };
  }
  throw new Error("目标模型无法读取待压缩媒体，且没有仍可用、有资格并能完整读取该历史的原模型；未提交摘要");
}
