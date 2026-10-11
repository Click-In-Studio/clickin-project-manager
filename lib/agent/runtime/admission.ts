import { withObservationRun, observeModelRequest } from "./observation";
import { AsyncLocalStorage } from "node:async_hooks";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import { isContextOverflow } from "@openclaw/ai/internal/runtime";
import type { StreamFn, AssistantMessage, Context, Model, SimpleStreamOptions } from "../../../vendor/openclaw/packages/llm-core/src/types";
import type { RuntimeToolDef } from "./tools";
import { HEARTBEAT_INTERVAL_MS } from "./config";
import * as db from "./admission-db";
import type { AdmissionResource, AdmissionTicket, InputWait } from "./admission-types";
import { subscribeDecisionEvents, subscribeSessionEvents } from "./events";
import { estimateRequestBudget, MAX_CONTEXT_OVERFLOW_RETRIES } from "./context-budget";

function budget(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
  return value;
}
export const admissionLimits = {
  context: budget("AGENT_CONTEXT_LIMIT", 8),
  llm: budget("AGENT_LLM_LIMIT", 4),
  local_tool: budget("AGENT_LOCAL_TOOL_LIMIT", 2),
  mmp: budget("AGENT_MMP_LIMIT", 4),
  agingMs: budget("AGENT_AGING_MS", 30_000),
};
type Scope = { runId: string; signal: AbortSignal; operationKey?: string; sequence: number; wait?: InputWait; waits: Map<string, InputWait>; waitTail: Promise<void>; park: () => void; busy: number };
const scopeStorage = new AsyncLocalStorage<Scope>();
const scopes = new Map<string, Scope>();
const pending = new Map<string, { ticket: AdmissionTicket; resolve: (ticket: AdmissionTicket) => void; reject: (error: unknown) => void }>();
const held = new Set<string>();
const waiting = new Map<string, InputWait>();
const subscriptions = new Map<string, Array<() => void>>();
const wakePending = new Set<string>();
let waking = false;
let pumping: Promise<void> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

function arm(): void {
  if (timer) return;
  let lastHeartbeat = 0;
  let lastWaitScan = 0;
  let lastRemoteScan = 0;
  let reconcilingRemote = false;
  timer = scopeStorage.exit(() => setInterval(() => {
    void pump().catch((e) => console.error("[agent-admission] 调度失败", e));
    if (!reconcilingRemote && Date.now()-lastRemoteScan >= 5_000 && [...pending.values()].some((p) => p.ticket.resource === "mmp")) {
      lastRemoteScan = Date.now();
      reconcilingRemote = true;
      // 进程内执行模式也能回收已确认终态的远端名额；网络查询不阻塞其他资源准入。
      void scopeStorage.exit(async () => (await import("@/lib/mmp/admitted-run")).reconcileMmpAdmissions())
        .catch((e) => console.error("[agent-admission] 远端对账失败",e))
        .finally(() => { reconcilingRemote = false; });
    }
    if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeat = Date.now();
      void db.heartbeatAdmissions([...held]).catch((e) => console.error("[agent-admission] 心跳失败", e));
    }
    if (!waking && waiting.size && (wakePending.size || Date.now()-lastWaitScan >= 5_000)) {
      const ids = wakePending.size ? [...wakePending] : [...waiting.keys()];
      wakePending.clear();
      lastWaitScan = Date.now();
      waking = true;
      void (async () => {
        for (const runId of ids) {
          const wait = waiting.get(runId);
          if (!wait) continue;
          if (await db.inputWaitReady(wait)) {
            wakePending.add(runId);
            const sessionId = await db.runSessionId(runId);
            if (sessionId) await (await import("./service")).resumeOrphans(sessionId);
          }
          const previous = await db.previousInputWait(runId);
          if (!previous) {
            waiting.delete(runId); wakePending.delete(runId);
            for (const off of subscriptions.get(runId) ?? []) off();
            subscriptions.delete(runId);
          }
        }
      })().catch((e) => console.error("[agent-admission] 输入唤醒失败", e)).finally(() => { waking = false; });
    }
    if (!pending.size && !held.size && !waiting.size) { clearInterval(timer); timer = undefined; }
  }, 100));
  timer.unref();
}
export function pump(): Promise<void> {
  if (pumping) return pumping;
  pumping = (async () => {
    for (const resource of ["context", "llm", "local_tool", "mmp"] as const) {
      const ids = [...pending].filter(([, p]) => p.ticket.resource === resource).map(([id]) => id);
      if (!ids.length) continue;
      for (const ticket of await db.claimAdmissions(resource, admissionLimits[resource], admissionLimits.agingMs, ids)) {
        const p = pending.get(ticket.id);
        if (p) { pending.delete(ticket.id); held.add(ticket.id); p.resolve(ticket); }
        else await db.finishAdmission(ticket.id, "failed");
      }
    }
  })().finally(() => { pumping = undefined; });
  return pumping;
}
export async function acquire(runId: string, key: string, resource: AdmissionResource, signal: AbortSignal): Promise<AdmissionTicket> {
  signal.throwIfAborted();
  const ticket = await db.requestAdmission(runId, key, resource);
  if (signal.aborted) { await db.finishAdmission(ticket.id,"failed"); signal.throwIfAborted(); }
  if (resource === "mmp" && ticket.remote_id && (ticket.state === "unknown" || ticket.state === "active")) {
    await db.reattachAdmission(ticket.id);
    held.add(ticket.id); arm(); return ticket;
  }
  if (ticket.state === "done") return ticket;
  if (ticket.state !== "ready") throw new Error("上一次操作的执行状态未确认，不能重复提交");
  arm();
  return new Promise<AdmissionTicket>((resolve, reject) => {
    const abort = () => {
      pending.delete(ticket.id);
      void db.finishAdmission(ticket.id, "failed").catch(reject);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    pending.set(ticket.id, {
      ticket,
      resolve: (t) => { signal.removeEventListener("abort", abort); resolve(t); },
      reject,
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else void pump().catch((e) => { pending.delete(ticket.id); signal.removeEventListener("abort", abort); reject(e); });
  });
}
export async function release(ticket: AdmissionTicket, state: "done" | "failed" | "unknown" = "done", result?: unknown): Promise<void> {
  await db.finishAdmission(ticket.id, state, result);
  held.delete(ticket.id);
  void pump().catch((e) => console.error("[agent-admission] 释放后调度失败", e));
}
export function currentAdmissionScope(): Scope | undefined { return scopeStorage.getStore(); }
export function runInAdmission<T>(runId: string, signal: AbortSignal, park: () => void, fn: () => Promise<T>): Promise<T> {
  const scope: Scope = { runId, signal, park, sequence: 0, busy: 0, waits: new Map(), waitTail: Promise.resolve() };
  scopes.set(runId, scope);
  return withObservationRun(runId, () => scopeStorage.run(scope, fn)).finally(() => { scopes.delete(runId); });
}
export async function waitForInput(runId: string, wait: InputWait): Promise<boolean> {
  const scope = scopes.get(runId);
  if (!scope) return false;
  const previous = await db.previousInputWait(runId);
  const oldWaits = previous?.kind === "all" ? previous.waits : previous ? [previous] : [];
  if (wait.kind === "subagent") {
    const ids = JSON.stringify([...wait.ids].sort());
    wait = oldWaits.find((w) => w.kind === "subagent" && JSON.stringify([...w.ids].sort()) === ids) ?? wait;
  }
  if (await db.inputWaitReady(wait)) { await db.setInputWait(runId, null); return true; }
  const key = wait.kind === "question" || wait.kind === "approval" ? wait.id : JSON.stringify(wait);
  scope.waits.set(key, wait);
  scope.waitTail = scope.waitTail.then(async () => {
    const waits = [...scope.waits.values()];
    scope.wait = waits.length === 1 ? waits[0] : { kind: "all", waits, ids: waits.flatMap((w) => w.kind === "subagent" ? w.ids : []) };
    await db.setInputWait(runId, scope.wait);
    await watchInputWait(runId, scope.wait);
  });
  await scope.waitTail;
  // 同回合其他工具结束后也会再次检查；有在途工作时不卸载上下文。
  if (!scope.signal.aborted && scope.busy <= scope.waits.size) scope.park();
  return false;
}
export function wrapTools(tools: RuntimeToolDef[]): RuntimeToolDef[] {
  return tools.map((tool) => ({ ...tool,
    completedResult: async (id) => {
      const scope = scopeStorage.getStore();
      return scope ? await db.completedToolResult(scope.runId,id) as Awaited<ReturnType<typeof tool.execute>> | undefined : undefined;
    },
    execute: async (id, args, signal, update) => {
    const scope = scopeStorage.getStore();
    if (!scope) return tool.execute(id, args, signal, update);
    scope.busy++;
    try {
      const completed = await db.completedToolResult(scope.runId,id);
      if (completed) return completed as Awaited<ReturnType<typeof tool.execute>>;
      await db.beginToolOperation(scope.runId,id);
      const result = await scopeStorage.run({ ...scope, operationKey: `tool:${id}`, sequence: 0 }, () => tool.executionResource === "local_tool" ? withLocalTool(id, () => tool.execute(id,args,signal,update)) : tool.execute(id, args, signal, update));
      if (!scope.signal.aborted) await db.saveToolResult(scope.runId,id,result);
      return result;
    } finally {
      scope.busy--;
      if (scope.wait && !scope.signal.aborted) {
        scope.waitTail = scope.waitTail.then(async () => {
          for (const [key,wait] of scope.waits) if (await db.inputWaitReady(wait)) scope.waits.delete(key);
          const waits = [...scope.waits.values()];
          scope.wait = waits.length > 1 ? { kind: "all", waits, ids: waits.flatMap((w) => w.kind === "subagent" ? w.ids : []) } : waits[0];
          await db.setInputWait(scope.runId,scope.wait ?? null);
          if (scope.wait) await watchInputWait(scope.runId,scope.wait);
        });
        await scope.waitTail;
      }
      if (scope.wait && scope.busy <= scope.waits.size && !scope.signal.aborted && !(await db.inputWaitReady(scope.wait)) && !scope.signal.aborted) scope.park();
    }
  } }));
}
export async function watchInputWait(runId: string, wait: InputWait): Promise<void> {
  if (JSON.stringify(waiting.get(runId)) === JSON.stringify(wait)) return;
  for (const off of subscriptions.get(runId) ?? []) off();
  waiting.set(runId,wait);
  const wake = () => { wakePending.add(runId); };
  const offs: Array<() => void> = [];
  async function subscribe(w: InputWait): Promise<void> {
    if (w.kind === "all") { for (const item of w.waits) await subscribe(item); }
    else if (w.kind === "subagent") {
      const sessionId = await db.runSessionId(runId);
      if (sessionId) offs.push(await subscribeSessionEvents(sessionId,wake));
    } else offs.push(await subscribeDecisionEvents(w.kind,w.id,wake));
  }
  await scopeStorage.exit(() => subscribe(wait));
  subscriptions.set(runId,offs);
  wake(); arm();
}
export type PrepareAdmittedRequest = (input: {
  model: Model;
  context: Context;
  options: SimpleStreamOptions | undefined;
  trigger: "pressure" | "context-overflow";
  signal: AbortSignal;
}) => Promise<Context>;

/** 资源准入内完成请求前预算控制；超窗只有在上下文确实缩减后才有限重试。 */
export function admittedStream(streamFn: StreamFn, prepareRequest?: PrepareAdmittedRequest): StreamFn {
  return (model, context, options) => {
    const scope = scopeStorage.getStore();
    if (!scope) return streamFn(model, context, options);
    const signal = options?.signal ? AbortSignal.any([scope.signal, options.signal]) : scope.signal;
    const out = createAssistantMessageEventStream();
    void (async () => {
      let ticket: AdmissionTicket | undefined;
      let result: AssistantMessage | undefined;
      let observedResult: AssistantMessage | undefined;
      let observation: Awaited<ReturnType<typeof observeModelRequest>> | undefined;
      const queuedAt = performance.now();
      try {
        ticket = await acquire(scope.runId, `llm:${model.id}:${await db.continuationKey(scope.runId)}`, "llm", signal);
        if (ticket.state === "done" && ticket.result) {
          result = ticket.result as AssistantMessage;
          out.push({ type: "done",reason: result.stopReason as "stop" | "length" | "toolUse",message: result });
          return;
        }
        signal.throwIfAborted();
        let requestContext = prepareRequest
          ? await prepareRequest({ model, context, options, trigger: "pressure", signal })
          : context;
        let overflowRetries = 0;
        for (;;) {
          signal.throwIfAborted();
          observation = await observeModelRequest(model, requestContext, "chat", performance.now() - queuedAt, options?.maxTokens);
          const stream = await streamFn(model, requestContext, {...options,signal});
          let retry = false;
          let emitted = false;
          for await (const event of stream) {
            if (event.type === "done") { result = event.message; observedResult = event.message; }
            if (event.type === "error") observedResult = event.error;
            if (event.type === "done" || event.type === "error") {
              const contextOverflow = event.type === "error"
                && isContextOverflow(event.error, model.contextTokens ?? model.contextWindow);
              await observation?.finish(
                observedResult,
                contextOverflow ? "context_overflow" : observedResult?.stopReason ?? "error",
              );
              observation = undefined;
            }
            if (
              event.type === "error"
              && !emitted
              && prepareRequest
              && overflowRetries < MAX_CONTEXT_OVERFLOW_RETRIES
              && isContextOverflow(event.error, model.contextTokens ?? model.contextWindow)
              && !signal.aborted
            ) {
              const before = estimateRequestBudget(model, requestContext, options).estimatedInputTokens;
              const recovered = await prepareRequest({
                model,
                context: requestContext,
                options,
                trigger: "context-overflow",
                signal,
              });
              const after = estimateRequestBudget(model, recovered, options).estimatedInputTokens;
              if (!signal.aborted && after < before) {
                requestContext = recovered;
                overflowRetries++;
                retry = true;
                observedResult = undefined;
                break;
              }
            }
            out.push(event);
            emitted = true;
          }
          if (!retry) break;
        }
      } catch (e) {
        const aborted = signal.aborted;
        await observation?.finish(observedResult, aborted ? "aborted" : "error");
        observation = undefined;
        out.push({ type: "error", reason: aborted ? "aborted" : "error", error: {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), stopReason: aborted ? "aborted" : "error", errorMessage: String(e),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } });
      } finally {
        await observation?.finish(observedResult, observedResult?.stopReason ?? (signal.aborted ? "aborted" : "error"));
        if (ticket) await release(ticket,result ? "done" : "failed",result);
      }
    })();
    return out;
  };
}
export async function withLocalTool<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const scope = scopeStorage.getStore();
  if (!scope) return fn();
  const ticket = await acquire(scope.runId, `${scope.operationKey ?? "local"}:${key}:${scope.sequence++}`, "local_tool", scope.signal);
  try { return await fn(); } finally { await release(ticket); }
}
