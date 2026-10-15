import { observeCompactionCheck, observeModelRequest } from "./observation";
import type {
  Context,
  MediaContent,
  Model,
  SimpleStreamOptions,
} from "../../../vendor/openclaw/packages/llm-core/src/types";
import type { AgentMessage } from "../../../vendor/openclaw/packages/agent-core/src/types";
import type { AgentCoreCompletionRuntimeDeps } from "../../../vendor/openclaw/packages/agent-core/src/runtime-deps";
import {
  Session,
  buildSessionContext,
} from "../../../vendor/openclaw/packages/agent-core/src/harness/session/session";
import {
  compact,
  prepareCompaction,
  type CompactionDetails,
} from "../../../vendor/openclaw/packages/agent-core/src/harness/compaction/compaction";
import { convertToLlm } from "../../../vendor/openclaw/packages/agent-core/src/harness/messages";
import { compactionSettingsFor, estimateRequestBudget } from "./context-budget";
import { usdOfUsage } from "./billing";

export type CompactionTrigger = "pressure" | "context-overflow";
export class CompactionBudgetError extends Error {}

export interface RequestCompactionOptions {
  session: Session;
  context: Context;
  model: Model;
  apiKey: string;
  streamOptions?: SimpleStreamOptions;
  signal: AbortSignal;
  trigger: CompactionTrigger;
  maxTokens?: number;
  calibration?: number;
  /** 显式读取还未落工具结果，摘要只处理持久旧前缀。 */
  pendingMedia?: MediaContent;
  completeSimple: AgentCoreCompletionRuntimeDeps["completeSimple"];
  compactFn?: typeof compact;
  shouldCompact?: (tokens: number, threshold: number) => boolean;
  refreshContext?: (context: Context) => Promise<Context>;
  rebuildMessages?: (messages: AgentMessage[]) => AgentMessage[];
  prepareMessages?: (messages: AgentMessage[], model: Model) => Promise<AgentMessage[]>;
  selectSummaryModel?: (messages: AgentMessage[], context: Context) => Promise<{ model: Model; apiKey: string }>;
  onCompacting?: (active: boolean) => Promise<void>;
  onUsage?: (usage: { usd: number; tokens: number; model: Model }) => Promise<void>;
}
function mediaParts(
  messages: AgentMessage[] | Context["messages"],
): MediaContent[] {
  return messages.flatMap((message) =>
    message.role !== "assistant" &&
    "content" in message &&
    Array.isArray(message.content)
      ? message.content.filter((part): part is MediaContent =>
          ["image", "file", "audio", "video"].includes(part.type),
        )
      : [],
  );
}
function mediaKey(part: MediaContent): string {
  return JSON.stringify([part.attachmentId, part.assetId, part.mimeType, part.source]);
}
function reference(part: MediaContent): MediaContent {
  const value = { ...part };
  delete value.data;
  return value;
}

/** 只有成功模型请求处理过的可回查旧媒体才能归档；上传、预检或读取本身不算分析完成。 */
function classifyMedia(
  messages: AgentMessage[],
  current: Context,
  previous?: CompactionDetails,
) {
  const delivered = new Set<string>();
  let pending: MediaContent[] = [];
  for (const message of current.messages) {
    pending.push(...mediaParts([message]));
    if (
      message.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted"
    ) {
      for (const part of pending) delivered.add(mediaKey(part));
      pending = [];
    }
  }
  const keep = new Map<string, MediaContent>();
  const references = new Map(
    (previous?.mediaReferences ?? []).map((part) => [
      mediaKey(part),
      reference(part),
    ]),
  );
  for (const part of [...(previous?.media ?? []), ...mediaParts(messages)]) {
    const key = mediaKey(part);
    if (
      (part.attachmentId || part.assetId) &&
      part.source &&
      delivered.has(key)
    )
      references.set(key, reference(part));
    else keep.set(key, part);
  }
  return { keep: [...keep.values()], references: [...references.values()] };
}

/** 先验证候选请求，再把检查点提交到持久分支。 */
export async function compactRequestContext(
  options: RequestCompactionOptions,
): Promise<Context> {
  const current = options.refreshContext
    ? await options.refreshContext(options.context)
    : options.context;
  const originalBudget = estimateRequestBudget(
    options.model,
    current,
    { maxTokens: options.maxTokens },
    options.calibration,
  );
  const mediaAdaptation = !originalBudget.mediaFits;
  const triggered =
    mediaAdaptation ||
    options.trigger === "context-overflow" ||
    (options.shouldCompact
      ? options.shouldCompact(
          originalBudget.estimatedInputTokens,
          originalBudget.pressureThreshold,
        )
      : originalBudget.pressured);
  const check = await observeCompactionCheck({
    trigger: options.trigger,
    ...originalBudget,
    triggered,
  });
  if (!triggered) {
    await check.finish("skipped");
    return current;
  }
  const input = {
    ...options,
    context: current,
    calibration: options.calibration ?? 1,
    options: {
      ...options.streamOptions,
      apiKey: options.apiKey,
      maxTokens: options.maxTokens,
    } as SimpleStreamOptions,
    prepareMessages: async (messages: AgentMessage[], model = options.model) => {
      const prepared = options.prepareMessages
        ? await options.prepareMessages(messages, model)
        : messages;
      return options.rebuildMessages
        ? options.rebuildMessages(prepared)
        : prepared;
    },
  };

  input.signal.throwIfAborted();
  const before = estimateRequestBudget(
    input.model,
    input.context,
    input.options,
    input.calibration,
  );

  const started = performance.now();
  let outcome = "unavailable";
  let afterTokens = before.estimatedInputTokens;
  let usd = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let summaryExecutionModel = input.model;
  const summarizedMedia = new Set<string>();
  await input.onCompacting?.(true);
  try {
    const path = await input.session.getBranch();
    const originalLeaf = path.at(-1)?.id;
    const preparation = prepareCompaction(
      path,
      compactionSettingsFor(
        input.model,
        input.options,
        input.trigger === "context-overflow" || mediaAdaptation,
      ),
    );
    if (!preparation.ok) throw preparation.error;
    if (!preparation.value) {
      await check.finish("skipped");
      return input.context;
    }
    const value = preparation.value;
    if (!value.messagesToSummarize.length && !value.turnPrefixMessages.length) {
      await check.finish("skipped");
      return input.context;
    }
    const previous = [...path]
      .reverse()
      .find((entry) => entry.type === "compaction");
    const classified = classifyMedia(
      [...value.messagesToSummarize, ...value.turnPrefixMessages],
      input.context,
      previous?.type === "compaction"
        ? (previous.details as CompactionDetails)
        : undefined,
    );
    value.mediaAdaptation = mediaAdaptation;
    value.mediaToKeep = classified.keep;
    value.mediaReferences = classified.references;
    let summaryModel = input.model;
    let summaryApiKey = input.apiKey;
    let summaryContext = input.context;
    const olderMessages = async (model: Model) => {
      const prior = (await input.session.buildContext()).messages.filter((message) => message.role === "compactionSummary");
      const retained = previous?.type === "compaction" ? (previous.details as CompactionDetails | undefined)?.media ?? [] : [];
      return input.prepareMessages([
        ...(retained.length ? [{ role: "user" as const, timestamp: 0, content: retained }] : []),
        ...prior, ...value.messagesToSummarize, ...value.turnPrefixMessages,
      ], model);
    };
    if (mediaAdaptation || input.pendingMedia) {
      const older = await olderMessages(input.model);
      summaryContext = { ...input.context, messages: convertToLlm(older) };
      if (!estimateRequestBudget(input.model, summaryContext, input.options).fits) {
        if (!input.selectSummaryModel) throw new Error("目标模型不支持待压缩媒体，缺少可读取原件的摘要模型");
        const selection = await input.selectSummaryModel(older, summaryContext);
        summaryModel = selection.model;
        summaryApiKey = selection.apiKey;
        summaryContext = { ...summaryContext, messages: convertToLlm(await olderMessages(summaryModel)) };
      }
    }
    // 正常压力下保留完整请求前缀；媒体适配只读旧前缀，未处理的新输入留给目标模型。
    const completeSimple: AgentCoreCompletionRuntimeDeps["completeSimple"] =
      async (model, context, options) => {
        input.signal.throwIfAborted();
        const summaryOptions = {
          ...input.options,
          ...options,
          reasoning: summaryModel === input.model ? input.options.reasoning : undefined,
          apiKey: summaryApiKey,
        };
        let request = context;
        let budget = estimateRequestBudget(
          model,
          request,
          summaryOptions,
          input.calibration,
        );
        if (!budget.fits) {
          const instruction = context.messages.at(-1)!;
          const older = await olderMessages(model);
          request = {
            ...context,
            messages: [...convertToLlm(older), instruction],
          };
          budget = estimateRequestBudget(
            model,
            request,
            summaryOptions,
            input.calibration,
          );
        }
        if (!budget.fits)
          throw new Error(
            "摘要请求本身超过预算；无法完整读取待压缩证据，未提交摘要",
          );
        const observation = await observeModelRequest(
          model,
          request,
          "compaction",
          0,
          summaryOptions.maxTokens,
        );
        const message = await input.completeSimple(
          model,
          request,
          summaryOptions,
        );
        await observation.finish(message, message.stopReason);
        usd += usdOfUsage(message.usage, model);
        cacheRead += message.usage.cacheRead;
        cacheWrite += message.usage.cacheWrite;
        await input.onUsage?.({
          usd: usdOfUsage(message.usage, model),
          model,
          tokens:
            message.usage.input +
            message.usage.output +
            message.usage.cacheRead +
            message.usage.cacheWrite,
        });
        if (message.stopReason === "stop")
          for (const part of mediaParts(request.messages))
            if (part.data) summarizedMedia.add(mediaKey(part));
        return message;
      };
    summaryExecutionModel = summaryModel;
    const result = await (input.compactFn ?? compact)(
      value,
      {
        systemPrompt: summaryContext.systemPrompt,
        tools: summaryContext.tools,
        messages: summaryContext.messages,
      },
      summaryModel,
      summaryApiKey,
      input.options.headers,
      "用中文写摘要，保留附件版本、回查定位和未处理资料。",
      input.signal,
      undefined,
      undefined,
      { completeSimple },
    );
    if (!result.ok) throw result.error;
    input.signal.throwIfAborted();
    const priorReferences = new Set(
      (previous?.type === "compaction"
        ? ((previous.details as CompactionDetails | undefined)
            ?.mediaReferences ?? [])
        : []
      ).map(mediaKey),
    );
    const details = (result.value.details ?? {
      readFiles: [],
      modifiedFiles: [],
    }) as CompactionDetails;
    result.value.details = details;
    details.mediaReferences = classified.references.filter(
      (part) =>
        priorReferences.has(mediaKey(part)) ||
        summarizedMedia.has(mediaKey(part)),
    );
    details.media = [
      ...classified.keep,
      ...classified.references.filter(
        (part) =>
          !priorReferences.has(mediaKey(part)) &&
          !summarizedMedia.has(mediaKey(part)),
      ),
    ];
    const candidate = {
      type: "compaction" as const,
      id: "candidate",
      parentId: originalLeaf ?? null,
      timestamp: new Date().toISOString(),
      summary: result.value.summary,
      firstKeptEntryId: result.value.firstKeptEntryId,
      tokensBefore: before.estimatedInputTokens,
      details: result.value.details,
    };
    const messages = await input.prepareMessages(
      [...buildSessionContext([...path, candidate]).messages, ...(input.pendingMedia ? [{ role: "user" as const, timestamp: 0, content: [input.pendingMedia] }] : [])],
    );
    const candidateContext = { ...input.context, messages: convertToLlm(messages) };
    const next = input.refreshContext ? await input.refreshContext(candidateContext) : candidateContext;
    const after = estimateRequestBudget(
      input.model,
      next,
      input.options,
      input.calibration,
    );
    afterTokens = after.estimatedInputTokens;
    if (!mediaAdaptation && afterTokens >= before.estimatedInputTokens)
      throw new Error("压缩后完整请求没有缩减，未提交摘要");
    if (!after.fits)
      throw new CompactionBudgetError(
        "保留必要媒体后仍超过请求预算，未提交摘要；请缩小任务或附件范围",
      );
    input.signal.throwIfAborted();
    if ((await input.session.getBranch()).at(-1)?.id !== originalLeaf)
      throw new Error("压缩期间会话分支改变，未提交过时摘要");
    await input.session.appendCompaction(
      candidate.summary,
      candidate.firstKeptEntryId,
      candidate.tokensBefore,
      candidate.details,
      true,
    );
    outcome = "committed";
    await check.finish("ok");
    return next;
  } catch (error) {
    if (outcome !== "committed")
      outcome = input.signal.aborted
        ? "aborted"
        : error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "rejected";
    await check.finish("error");
    if (!input.signal.aborted && before.fits && outcome !== "committed") {
      console.warn(
        "[agent-compaction] 沿用未修改的可用上下文:",
        error instanceof Error ? error.message : String(error),
      );
      return current;
    }
    throw error;
  } finally {
    console.info(
      "[agent-compaction]",
      JSON.stringify({
        model: input.model.id,
        api: input.model.api,
        summaryModel: summaryExecutionModel.id,
        summaryProvider: summaryExecutionModel.provider,
        mediaAdaptation,
        trigger: input.trigger,
        beforeTokens: before.estimatedInputTokens,
        afterTokens,
        mediaTokens: before.mediaTokens,
        mediaCount: before.mediaCount,
        outputReserve: before.outputReserveTokens,
        window: before.effectiveContextWindow,
        basis: before.basis,
        outcome,
        elapsedMs: Math.round(performance.now() - started),
        cacheRead,
        cacheWrite,
        usd,
      }),
    );
    await input.onCompacting?.(false);
  }
}
