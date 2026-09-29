// 会话附件与资产文件共用的 MMP 自动预检入口。
//
// MMP 2.0 自己用 purpose + Content-Type 选择唯一能力，并由任务端生成可直接交给
// base model 的 agent_context。宿主不维护模态枚举、不解释 digest，也不根据任务 id
// 推断能力；PDF、视频等专属预检上线后只需出现在 MMP registry 中。MMP registry
// 不应让图片 triage 接受 PDF；没有 PDF triage 时，PDF 留给既有结构化阅读或 OCR。

import {
  MmpError,
  media,
  resolveCapability,
  type MmpClient,
  type Capability,
  type CapabilitiesResponse,
} from "@mmp/client";
import { presignedGet } from "@/lib/r2";
import { getMmpClient } from "./client";

export type AttachmentPreflightOutcome =
  | { status: "ok"; contextText: string; capabilityId: string }
  | { status: "unavailable"; reason: string; contextText: string };

export type PreflightInput = {
  /** 稳定文件行 id，用于进程内复用 MMP media_id。 */
  attachmentId: string;
  /** 上传入口确认的媒体种类；Safari 录音可能把容器声明成 video/mp4。 */
  mediaKind?: string | null;
  /** 浏览器 / 资产记录的原始 Content-Type；媒体句柄原样保留，节点仍会嗅探实际字节。 */
  mimeType: string;
  r2Key: string;
};

const RUN_TIMEOUT_MS = 2 * 60_000;
const POLL_WAIT_SEC = 30;
const MEDIA_ID_CAP = 500;
const mediaIdByFile = new Map<string, string>();

function rememberMediaId(fileId: string, mediaId: string): void {
  mediaIdByFile.delete(fileId);
  mediaIdByFile.set(fileId, mediaId);
  while (mediaIdByFile.size > MEDIA_ID_CAP) mediaIdByFile.delete(mediaIdByFile.keys().next().value!);
}

/** MMP 不可用时由宿主生成的最小上下文；不冒充任务端的 agent_context。 */
export function renderPreflightUnavailable(code: string): string {
  return `⚠ Click-In 未获得 MMP 媒体预检结果（${code}）；不能据此判断附件内容，原件仍可通过附件工具读取。`;
}

/** 只声明稳定意图与 MIME；任务 id、模态与节点选择全部由 MMP registry 决定。 */
export function resolveTriageCapability(
  registry: CapabilitiesResponse,
  contentType: string,
): Capability | null {
  try {
    return resolveCapability(registry, { purpose: "triage", contentType });
  } catch (error) {
    if (error instanceof MmpError && error.code === "unsupported_type") return null;
    throw error;
  }
}

/**
 * 能力发现使用媒体的语义 Content-Type；媒体句柄仍保留浏览器给出的原始 MIME。
 * mediaKind 是上传入口的开放字符串，不在这里枚举 audio/image/video 或映射任务 id。
 */
export function capabilityContentType(input: Pick<PreflightInput, "mediaKind" | "mimeType">): string {
  const kind = input.mediaKind?.trim().toLowerCase();
  const bare = input.mimeType.split(";", 1)[0].trim().toLowerCase();
  if (!kind || !/^[a-z][a-z0-9!#$&^_.+-]*$/.test(kind)) return bare;
  const slash = bare.indexOf("/");
  return slash > 0 ? `${kind}${bare.slice(slash)}` : bare;
}

function unavailable(code: string, reason: string): AttachmentPreflightOutcome {
  return { status: "unavailable", reason, contextText: renderPreflightUnavailable(code) };
}

export async function preflightAttachment(
  input: PreflightInput,
  opts: {
    signal?: AbortSignal;
    client?: MmpClient | null;
    registry?: CapabilitiesResponse;
    capability?: Capability;
    usage?: { userId: string; productionId: string | null };
  } = {},
): Promise<AttachmentPreflightOutcome> {
  const client = opts.client === undefined ? getMmpClient() : opts.client;
  if (!client) return unavailable("not_configured", "MMP 服务未配置；原件仍可用。");

  try {
    const registry = opts.registry ?? await client.capabilities();
    const discoveryType = capabilityContentType(input);
    const capability = opts.capability ?? resolveTriageCapability(registry, discoveryType);
    if (!capability) {
      return unavailable("unsupported_type", `MMP 当前没有匹配 ${discoveryType} 的自动预检能力；原件仍可用。`);
    }

    const source = media.get(presignedGet(input.r2Key, 15 * 60), undefined, input.mimeType);
    const knownMediaId = mediaIdByFile.get(input.attachmentId);
    const handle = knownMediaId ? media.refOr(knownMediaId, source) : source;
    const done = await client.run(
      { type: capability.id, media: handle, priority: "interactive" },
      { pollWaitSec: POLL_WAIT_SEC, timeoutMs: RUN_TIMEOUT_MS, signal: opts.signal },
    );
    rememberMediaId(input.attachmentId, done.media_id);
    if (!done.agent_context?.text) throw new Error(`${capability.id} 完成但没有 agent_context`);

    if (opts.usage && !done.cached) {
      const timings = done.timings_ms ?? (done.result as { timings_ms?: Record<string, number> } | undefined)?.timings_ms ?? {};
      const computeMs = Object.entries(timings)
        .filter(([key, value]) => !["total", "fetch", "download", "queue", "load"].includes(key) && Number.isFinite(value))
        .reduce((sum, [, value]) => sum + Math.max(0, value), 0);
      await (await import("./usage-db")).recordMmpUsage({
        ...opts.usage,
        type: capability.id,
        tier: String(done.source?.tier ?? capability.tiers[0]?.tier ?? "cpu"),
        computeMs,
      });
    }
    return { status: "ok", contextText: done.agent_context.text, capabilityId: capability.id };
  } catch (error) {
    const code = error instanceof MmpError ? error.code : "unexpected";
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[mmp] 自动预检失败（${input.attachmentId}, ${code}）：${detail}`);
    return unavailable(code, `MMP 预检失败（${code}）；原件仍可用。`);
  }
}

/** 一条消息里的附件共享一次 capability discovery；健康 registry 不匹配的附件不预检。 */
export async function preflightAttachments(
  inputs: PreflightInput[],
  opts: {
    signal?: AbortSignal;
    client?: MmpClient | null;
    usage?: { userId: string; productionId: string | null };
  } = {},
): Promise<Record<string, AttachmentPreflightOutcome>> {
  if (!inputs.length) return {};
  const client = opts.client === undefined ? getMmpClient() : opts.client;
  if (!client) {
    return Object.fromEntries(inputs.map((input) => [input.attachmentId,
      unavailable("not_configured", "MMP 服务未配置；原件仍可用。"),
    ]));
  }
  try {
    const registry = await client.capabilities();
    const pairs = await Promise.all(inputs.map(async (input) => {
      let capability: Capability | null;
      try {
        capability = resolveTriageCapability(registry, capabilityContentType(input));
      } catch (error) {
        const code = error instanceof MmpError ? error.code : "unexpected";
        return [input.attachmentId, unavailable(code, `MMP 能力解析失败（${code}）；原件仍可用。`)] as const;
      }
      if (!capability) return null;
      return [input.attachmentId, await preflightAttachment(input, {
        ...opts, client, registry, capability,
      })] as const;
    }));
    return Object.fromEntries(pairs.filter((pair): pair is NonNullable<typeof pair> => pair !== null));
  } catch (error) {
    const code = error instanceof MmpError ? error.code : "unexpected";
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[mmp] capability discovery 失败（${code}）：${detail}`);
    return Object.fromEntries(inputs.map((input) => [input.attachmentId,
      unavailable(code, `MMP 能力发现失败（${code}）；原件仍可用。`),
    ]));
  }
}

/** 测试用：避免不同用例之间复用 media_id。 */
export function clearAttachmentPreflightCacheForTests(): void {
  mediaIdByFile.clear();
}
