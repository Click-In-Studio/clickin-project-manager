import { AsyncLocalStorage } from "node:async_hooks";
import type { AssistantMessage, Context, Model } from "../../../vendor/openclaw/packages/llm-core/src/types";
import { estimateContextTokens } from "../../../vendor/openclaw/packages/agent-core/src/harness/compaction/compaction";
import { startObservation, finishObservation, type ObservationKind } from "./observation-db";
import { requestOutputTokens, estimateRequestBudget } from "./context-budget";

type Scope = { runId: string; sources: Record<string, string[]>; retrievalIds: string[]; requestId: string | null; tierMode: string };
const storage = new AsyncLocalStorage<Scope>();
export function withObservationRun<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ runId, sources: {}, retrievalIds: [], requestId: null, tierMode: "all_tools" }, fn);
}
export function setToolObservationSources(sources: Record<string, string[]>, tierMode = "all_tools"): void {
  const scope = storage.getStore();
  if (scope) { scope.sources = sources; scope.tierMode = tierMode; }
}
export function addObservationTools(source: "dynamic" | "deferred", names: string[]): void {
  const scope = storage.getStore();
  if (scope) scope.sources[source] = [...new Set([...(scope.sources[source] ?? []), ...names])];
}
export async function observeRetrieval(kind: Extract<ObservationKind, "tool_retrieval" | "memory_retrieval">, mode: "automatic" | "explicit", userId: string | null) {
  const scope = storage.getStore();
  const id = await startObservation(kind, scope?.runId ?? null, { mode, requestId: scope?.requestId ?? null }, userId);
  if (id && scope) scope.retrievalIds.push(id);
  const started = performance.now();
  return { finish: (data: object) => finishObservation(id, performance.now() - started, data) };
}
export async function observeModelRequest(model: Model, context: Context, purpose: "chat" | "compaction", admissionMs: number, maxTokens?: number, costBudget?: object) {
  const scope = storage.getStore();
  const names = context.tools?.map(t => t.name) ?? [];
  const sources = Object.fromEntries(Object.entries(scope?.sources ?? {}).map(([source, tools]) => [source, [...new Set(tools.filter(n => names.includes(n)))]]));
  sources.unattributed = names.filter(n => !Object.values(sources).some(tools => tools.includes(n)));
  const id = await startObservation("model_request", scope?.runId ?? null, {
    purpose, ...(costBudget ? { costBudget } : {}), model: model.id, provider: model.provider, contextWindow: model.contextWindow,
    maxOutputTokens: requestOutputTokens(model, { maxTokens }), effectiveContextWindow: model.contextTokens ?? model.contextWindow,
    toolSchemaChars: JSON.stringify(context.tools ?? []).length, contextEstimate: estimateContextTokens(context.messages),
    requestBudget: estimateRequestBudget(model, context, { maxTokens }),
    messageCount: context.messages.length, systemChars: context.systemPrompt?.length ?? 0,
    toolCount: names.length, tools: names, sources, retrievalIds: [...(scope?.retrievalIds ?? [])],
    automaticMemoryRecall: "disabled", tierMode: scope?.tierMode ?? "all_tools", admissionMs,
  });
  if (scope && purpose === "chat") scope.requestId = id;
  const started = performance.now();
  return { finish: (message: AssistantMessage | undefined, status: string) => finishObservation(id, performance.now() - started, {
    status, stopReason: message?.stopReason ?? null,
    usage: message ? { input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite, totalTokens: message.usage.totalTokens,
      inputIncludingCache: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite } : null,
  }) };
}
export async function observeCompactionCheck(data: object) {
  const id = await startObservation("compaction_check", storage.getStore()?.runId ?? null, data);
  const started = performance.now();
  return { finish: (status: "skipped" | "ok" | "error") => finishObservation(id, performance.now() - started, { status }) };
}
