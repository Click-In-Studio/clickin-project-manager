// next 侧调用运行时的统一入口（#367 §4.2 进程边界）。
//
// 只有三个动作需要触达"执行者"（它们碰进程内的 harness）：发起 run / 中途插话 / 中止。
// 其余（历史、列表、改名、审批与提问的决议）都是 DB 读写，next 直接做，与执行者无关——
// 观看者与执行者解耦（§4.4 ③）的自然结果。
//
// AGENT_RUNNER_URL 设了 → 走 loopback HTTP 到独立 agent-runner 进程；没设 → 进程内
// 直接调 service（测试与灰度首期）。两条路径语义一致。

import * as service from "./service";

export interface StartRunRequest {
  sessionId: string;
  userId: string;
  message: string;
  pageKey?: string | null;
}

function runnerUrl(): string | null {
  const url = process.env.AGENT_RUNNER_URL?.trim();
  return url ? url.replace(/\/$/, "") : null;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const base = runnerUrl()!;
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(data.error || `agent-runner ${path} failed (${res.status})`), { status: res.status });
  return data;
}

export async function startRun(input: StartRunRequest): Promise<{ runId: string }> {
  if (!runnerUrl()) return service.startRun(input);
  return post<{ runId: string }>("/runs", input);
}

export async function steerRun(sessionId: string, message: string): Promise<{ runId: string } | null> {
  if (!runnerUrl()) return service.steerRun(sessionId, message);
  const r = await post<{ runId: string | null }>("/runs/steer", { sessionId, message });
  return r.runId ? { runId: r.runId } : null;
}

export async function abortRun(sessionId: string): Promise<boolean> {
  if (!runnerUrl()) return service.abortRun(sessionId);
  const r = await post<{ aborted: boolean }>("/runs/abort", { sessionId });
  return r.aborted;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await abortRun(sessionId).catch(() => false);
  await service.deleteSessionRows(sessionId);
}

export { getHistory, listSessions, renameSession, isRunnerSession } from "./service";
