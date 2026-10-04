// MMP 2.1 的标准算力审计口径。usage.compute_ms 是唯一真值；旧 timings_ms 只在
// 对端尚未升级时兜底，且必须打日志，避免把排队、下载或冷启动误算给用户。

import type { JobDone } from "@mmp/client";

const NON_COMPUTE_TIMING_KEYS = new Set(["total", "fetch", "download", "queue", "load"]);

export function legacyComputeMs(timings: Record<string, number> | undefined): number {
  return Object.entries(timings ?? {})
    .filter(([key, value]) => !NON_COMPUTE_TIMING_KEYS.has(key) && Number.isFinite(value))
    .reduce((sum, [, value]) => sum + Math.max(0, value), 0);
}

export function billableMmpCompute(
  done: Pick<JobDone, "job_id" | "type" | "usage">,
  fallback: () => number,
): { ms: number; estimated: boolean } {
  if (done.usage && Number.isFinite(done.usage.compute_ms) && done.usage.compute_ms >= 0) {
    return { ms: Math.round(done.usage.compute_ms), estimated: false };
  }
  const ms = Math.max(0, Math.round(fallback()));
  console.warn(`[mmp] ${done.type} 响应缺 usage.compute_ms，按旧口径兜底计费（job ${done.job_id}）`);
  return { ms, estimated: true };
}
