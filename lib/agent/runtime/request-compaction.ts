import type { AssistantMessage, Context, Model } from "../../../vendor/openclaw/packages/llm-core/src/types";
import type { AgentMessage } from "../../../vendor/openclaw/packages/agent-core/src/types";
import type { AgentCoreCompletionRuntimeDeps } from "../../../vendor/openclaw/packages/agent-core/src/runtime-deps";
import { convertToLlm } from "../../../vendor/openclaw/packages/agent-core/src/harness/messages";
import { Session } from "../../../vendor/openclaw/packages/agent-core/src/harness/session/session";
import {
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  prepareCompaction,
  type CompactionSettings,
} from "../../../vendor/openclaw/packages/agent-core/src/harness/compaction/compaction";
import { observeCompactionCheck, observeModelRequest } from "./observation";
import { estimateRequestBudget } from "./context-budget";
import { usdOfUsage } from "./billing";

export interface RequestCompactionUsage {
  usd: number;
  tokens: number;
}

export interface RequestCompactionOptions {
  session: Session;
  context: Context;
  model: Model;
  apiKey: string;
  signal: AbortSignal;
  trigger: "pressure" | "context-overflow";
  maxTokens?: number;
  completeSimple: AgentCoreCompletionRuntimeDeps["completeSimple"];
  compactFn?: typeof compact;
  shouldCompact?: (estimatedInputTokens: number, threshold: number) => boolean;
  rebuildMessages?: (messages: AgentMessage[]) => AgentMessage[];
  onCompacting?: (active: boolean) => Promise<void>;
  onUsage?: (usage: RequestCompactionUsage) => Promise<void>;
}

const PRESSURE_ATTEMPTS = 2;

/** 在真实 provider 请求前压缩持久 transcript，并返回同一请求头下的新消息面。 */
export async function compactRequestContext(options: RequestCompactionOptions): Promise<Context> {
  const initialBudget = estimateRequestBudget(options.model, options.context, { maxTokens: options.maxTokens });
  const forced = options.trigger === "context-overflow";
  const triggered = forced || (options.shouldCompact
    ? options.shouldCompact(initialBudget.estimatedInputTokens, initialBudget.pressureThreshold)
    : initialBudget.pressured);
  const check = await observeCompactionCheck({
    trigger: options.trigger,
    ...initialBudget,
    triggered,
  });
  if (!triggered || options.signal.aborted) {
    await check.finish("skipped");
    return options.context;
  }

  let current = options.context;
  let committed = false;
  let compacting = false;
  let status: "ok" | "error" = "ok";
  try {
    compacting = true;
    await options.onCompacting?.(true);
    const attempts = forced ? 1 : PRESSURE_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt++) {
      options.signal.throwIfAborted();
      const settings: CompactionSettings = forced
        ? { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 0 }
        : DEFAULT_COMPACTION_SETTINGS;
      const preparation = prepareCompaction(await options.session.getBranch(), settings);
      if (!preparation.ok) throw preparation.error;
      if (!preparation.value) break;

      const tapped = {
        completeSimple: async (...args: Parameters<AgentCoreCompletionRuntimeDeps["completeSimple"]>) => {
          const [model, context, requestOptions] = args;
          const observation = await observeModelRequest(
            model,
            context,
            "compaction",
            0,
            requestOptions?.maxTokens,
          );
          let message: AssistantMessage | undefined;
          try {
            message = await options.completeSimple(...args);
            return message;
          } finally {
            await observation.finish(
              message,
              message?.stopReason ?? (options.signal.aborted ? "aborted" : "error"),
            );
            if (message?.usage) {
              await options.onUsage?.({
                usd: usdOfUsage(message.usage, model),
                tokens: message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite,
              });
            }
          }
        },
      };
      const result = await (options.compactFn ?? compact)(
        preparation.value,
        { systemPrompt: current.systemPrompt, tools: current.tools },
        options.model,
        options.apiKey,
        undefined,
        "用中文写摘要",
        options.signal,
        "low",
        undefined,
        tapped,
      );
      if (!result.ok) throw result.error;
      options.signal.throwIfAborted();
      await options.session.appendCompaction(
        result.value.summary,
        result.value.firstKeptEntryId,
        result.value.tokensBefore,
        result.value.details,
        true,
      );
      committed = true;
      const rebuilt = (await options.session.buildContext()).messages;
      current = {
        ...current,
        messages: convertToLlm(options.rebuildMessages?.(rebuilt) ?? rebuilt),
      };
      const budget = estimateRequestBudget(options.model, current, { maxTokens: options.maxTokens });
      if (forced || !budget.pressured) break;
    }
  } catch (error) {
    status = "error";
    if (!options.signal.aborted) console.error("[agent-runtime] 请求前 compaction 失败（沿用可用上下文）:", error);
    if (!committed) current = options.context;
  } finally {
    try {
      if (compacting) await options.onCompacting?.(false);
    } finally {
      await check.finish(status);
    }
  }
  return current;
}
