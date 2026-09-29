// MMP 动态 capability 的统一执行器。调用方必须先完成附件归属或资产预览权限校验，
// 本层只接受已经授权的稳定文件行，不把 media_id 暴露为 Click-In 授权凭证。

import {
  MmpError,
  matchesMediaType,
  media,
  type Capability,
  type MmpClient,
} from "@mmp/client";
import { neutralizeInjectionTags } from "@/lib/agent/agent-injection-safety";
import { presignedGet } from "@/lib/r2";
import { getMmpClient } from "./client";
import { mmpMediaHandle, rememberMmpMediaId } from "./media-cache";
import { recordMmpUsage } from "./usage-db";

const RUN_TIMEOUT_MS = 10 * 60_000;
const POLL_WAIT_SEC = 30;
export const MMP_RESULT_MAX_CHARS = 24_000;

export type AuthorizedMmpFile = {
  fileId: string;
  r2Key: string;
  mimeType: string;
};

function computeMsOf(timings: Record<string, number> | undefined): number {
  return Object.entries(timings ?? {})
    .filter(([key, value]) => !["total", "fetch", "download", "queue", "load"].includes(key) && Number.isFinite(value))
    .reduce((sum, [, value]) => sum + Math.max(0, value), 0);
}

function clipped(text: string): string {
  const safe = neutralizeInjectionTags(text.replace(/\u0000/g, "�"));
  return safe.length <= MMP_RESULT_MAX_CHARS
    ? safe
    : `${safe.slice(0, MMP_RESULT_MAX_CHARS)}\n…（MMP 结果超过 ${MMP_RESULT_MAX_CHARS} 字符，已截断）`;
}

function renderResult(capability: Capability, done: Awaited<ReturnType<MmpClient["run"]>>): string {
  // 节点按 registry 的 output.schema 校验结构；宿主不解释任务专有字段，只做通用、安全的文本化。
  const outputSchema = typeof capability.output.schema === "string" ? capability.output.schema : "inline-json-schema";
  const source = `来源：${done.source.engine}@${done.source.engine_version}，tier=${done.source.tier}`
    + `，schema=${outputSchema}`
    + `${done.source.degraded ? `，已降级（${done.source.degraded_reason ?? "未说明"}）` : ""}`
    + `${done.cached ? "，缓存命中" : ""}`;
  if (done.agent_context?.text) return clipped(`${source}\n${done.agent_context.text}`);
  if (done.result !== undefined) {
    let json: string;
    try { json = JSON.stringify(done.result, null, 2); } catch { json = "（结果无法序列化）"; }
    return clipped(`${source}\n${json}`);
  }
  if (done.result_ref) {
    return clipped(`${source}\n任务产生了外置结果（${done.result_ref.content_type}，${done.result_ref.bytes} bytes，sha256=${done.result_ref.sha256}），当前结果未内联。`);
  }
  return `${source}\n任务完成，但没有可呈现的结果。`;
}

export async function runMmpCapability(
  args: {
    capability: Capability;
    file: AuthorizedMmpFile;
    tier?: string;
    params?: Record<string, unknown>;
    userId: string;
    productionId: string | null;
  },
  opts: { client?: MmpClient | null; signal?: AbortSignal } = {},
): Promise<string> {
  const client = opts.client === undefined ? getMmpClient() : opts.client;
  if (!client) return "MMP capability unavailable（not_configured）：服务未配置。";

  try {
    // run 建立时的 capability 只决定模型看见什么；提交前以此刻在线 registry 为准。
    const current = (await client.capabilities()).capabilities
      .find((entry) => entry.capability.id === args.capability.id)?.capability;
    if (!current) return `MMP capability unavailable（${args.capability.id}）：当前没有在线节点提供该能力。`;
    const tier = args.tier?.trim() || undefined;
    if (tier && !current.tiers.some((item) => item.tier === tier)) {
      return `MMP capability unavailable（${args.capability.id}@${tier}）：当前在线节点没有该档位。`;
    }
    if (!current.input.media.accepts.some((pattern) => matchesMediaType(pattern, args.file.mimeType))) {
      return `MMP capability unavailable（unsupported_type）：${args.capability.id} 当前不接受 ${args.file.mimeType}。`;
    }

    const source = media.get(presignedGet(args.file.r2Key, 15 * 60), undefined, args.file.mimeType);
    const done = await client.run({
      type: current.id,
      media: mmpMediaHandle(args.file.fileId, source),
      ...(tier ? { tier: tier as "cpu" | "gpu-fast" | "gpu" | "remote" } : {}),
      ...(args.params ? { params: args.params } : {}),
      priority: "interactive",
    }, { pollWaitSec: POLL_WAIT_SEC, timeoutMs: RUN_TIMEOUT_MS, signal: opts.signal });
    rememberMmpMediaId(args.file.fileId, done.media_id);
    if (!done.cached) {
      const timings = done.timings_ms ?? (done.result as { timings_ms?: Record<string, number> } | undefined)?.timings_ms;
      await recordMmpUsage({
        userId: args.userId,
        productionId: args.productionId,
        type: current.id,
        tier: String(done.source.tier),
        computeMs: computeMsOf(timings),
      });
    }
    return renderResult(current, done);
  } catch (error) {
    const code = error instanceof MmpError ? error.code : "unexpected";
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[mmp] capability ${args.capability.id} 执行失败（${code}）：${detail}`);
    return `MMP capability unavailable（${code}）：本次处理没有产出结果。`;
  }
}
