// 会话附件与资产文件共用的 MMP 自动预检入口。
//
// 哪些预检存在、消费哪种媒体模态，由 MMP /capabilities 决定：宿主只认
// `triage.*` 命名空间，不维护 audio/image/video → task 的本地映射。自动注入与
// agent 显式读取都走本入口，因此 MMP 新增 triage.image / triage.video 时无需再接线。

import {
  MmpError,
  media,
  renderDigest,
  renderUnavailable,
  type MmpClient,
  type Capability,
  type Digest,
} from "@mmp/client";
import { presignedGet } from "@/lib/r2";
import { getMmpClient } from "./client";

export type AttachmentPreflightOutcome =
  | { status: "ok"; renderedDigest: string; capabilityIds: string[] }
  | { status: "unavailable"; reason: string; renderedDigest: string };

export type PreflightInput = {
  /** 上传端探测的媒体种类优先于 MIME；Safari 录音可能是 video/mp4。 */
  mediaKind?: string | null;
  /** 稳定文件行 id，用于进程内复用 MMP media_id。 */
  attachmentId: string;
  fileName: string;
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

/** 宿主只负责识别媒体模态；具体能否处理由 MMP capability registry 裁决。 */
export function modalityOf(input: Pick<PreflightInput, "mediaKind" | "mimeType" | "fileName">): string | null {
  if (input.mediaKind) return input.mediaKind;
  const top = /^(audio|image|video)\//.exec(input.mimeType)?.[1];
  if (top) return top;
  const lower = input.fileName.toLowerCase();
  if (/\.(mp3|wav|flac|aiff?|m4a|ogg|amr)$/.test(lower)) return "audio";
  if (/\.(png|jpe?g|tiff?|webp)$/.test(lower)) return "image";
  if (/\.(mp4|webm|mov|mkv)$/.test(lower)) return "video";
  if (input.mimeType === "application/pdf" || lower.endsWith(".pdf")) return "document";
  return null;
}

export function matchingTriageCapabilities(capabilities: Capability[], modality: string): Capability[] {
  return capabilities.filter((capability) => capability.id.startsWith("triage.") && capability.modal === modality);
}

export async function preflightAttachment(
  input: PreflightInput,
  opts: {
    signal?: AbortSignal;
    client?: MmpClient | null;
    capabilities?: Capability[];
    usage?: { userId: string; productionId: string | null };
  } = {},
): Promise<AttachmentPreflightOutcome> {
  const modality = modalityOf(input);
  if (!modality) {
    const reason = "该文件没有可匹配的媒体模态；原件仍可用。";
    return { status: "unavailable", reason, renderedDigest: renderUnavailable("unsupported_media") };
  }
  const client = opts.client === undefined ? getMmpClient() : opts.client;
  if (!client) {
    const reason = "MMP 服务未配置；原件仍可用。";
    return { status: "unavailable", reason, renderedDigest: renderUnavailable("not_configured") };
  }

  try {
    const capabilities = opts.capabilities ?? (await client.capabilities()).capabilities.map((entry) => entry.capability);
    const tasks = matchingTriageCapabilities(
      capabilities,
      modality,
    );
    if (!tasks.length) {
      const reason = `MMP 当前没有可用于 ${modality} 的自动预检能力；原件仍可用。`;
      return { status: "unavailable", reason, renderedDigest: renderUnavailable("no_matching_triage") };
    }

    const rendered: string[] = [];
    const completed: string[] = [];
    let knownMediaId = mediaIdByFile.get(input.attachmentId);
    for (const task of tasks) {
      const source = media.get(presignedGet(input.r2Key, 15 * 60), undefined, input.mimeType);
      const handle = knownMediaId ? media.refOr(knownMediaId, source) : source;
      const done = await client.run(
        { type: task.id, media: handle, priority: "interactive" },
        { pollWaitSec: POLL_WAIT_SEC, timeoutMs: RUN_TIMEOUT_MS, signal: opts.signal },
      );
      knownMediaId = done.media_id;
      rememberMediaId(input.attachmentId, done.media_id);
      if (!done.result) throw new Error(`${task.id} 完成但没有 result`);
      if (opts.usage && !done.cached) {
        const timings = done.timings_ms ?? (done.result as { timings_ms?: Record<string, number> }).timings_ms ?? {};
        const computeMs = Object.entries(timings)
          .filter(([key, value]) => !["total", "fetch", "download", "queue", "load"].includes(key) && Number.isFinite(value))
          .reduce((sum, [, value]) => sum + Math.max(0, value), 0);
        await (await import("./usage-db")).recordMmpUsage({
          ...opts.usage,
          type: task.id,
          tier: String(done.source?.tier ?? task.tiers[0]?.tier ?? "cpu"),
          computeMs,
        });
      }
      rendered.push(renderDigest(done.result as unknown as Digest));
      completed.push(task.id);
    }
    return { status: "ok", renderedDigest: rendered.join("\n"), capabilityIds: completed };
  } catch (error) {
    const code = error instanceof MmpError ? error.code : "unexpected";
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[mmp] 自动预检失败（${input.attachmentId}, ${code}）：${detail}`);
    return {
      status: "unavailable",
      reason: `MMP 预检失败（${code}）；原件仍可用。`,
      renderedDigest: renderUnavailable(code),
    };
  }
}

/** 一条消息里的附件共享一次 capability discovery；无媒体模态的普通文件不做预检。 */
export async function preflightAttachments(
  inputs: PreflightInput[],
  opts: {
    signal?: AbortSignal;
    client?: MmpClient | null;
    usage?: { userId: string; productionId: string | null };
  } = {},
): Promise<Record<string, AttachmentPreflightOutcome>> {
  const mediaInputs = inputs.filter((input) => modalityOf(input));
  if (!mediaInputs.length) return {};
  const client = opts.client === undefined ? getMmpClient() : opts.client;
  if (!client) {
    const pairs = await Promise.all(mediaInputs.map(async (input) => [
      input.attachmentId,
      await preflightAttachment(input, { ...opts, client: null }),
    ] as const));
    return Object.fromEntries(pairs);
  }
  try {
    const capabilities = (await client.capabilities()).capabilities.map((entry) => entry.capability);
    const pairs = await Promise.all(mediaInputs.map(async (input) => [
      input.attachmentId,
      await preflightAttachment(input, { ...opts, client, capabilities }),
    ] as const));
    return Object.fromEntries(pairs);
  } catch (error) {
    const code = error instanceof MmpError ? error.code : "unexpected";
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[mmp] capability discovery 失败（${code}）：${detail}`);
    return Object.fromEntries(mediaInputs.map((input) => [input.attachmentId, {
      status: "unavailable" as const,
      reason: `MMP 能力发现失败（${code}）；原件仍可用。`,
      renderedDigest: renderUnavailable(code),
    }]));
  }
}

/** 测试用：避免不同用例之间复用 media_id。 */
export function clearAttachmentPreflightCacheForTests(): void {
  mediaIdByFile.clear();
}
