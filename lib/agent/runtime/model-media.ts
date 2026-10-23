import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import {
  Input,
  BufferSource,
  MP4,
  QTFF,
  WEBM,
  WAVE,
  MP3,
  OGG,
  FLAC,
} from "mediabunny";
import { parsePdf } from "@/lib/doc-extract/pdf";
import { presignedGet } from "@/lib/r2";
import type { MediaContent, Model } from "../../../vendor/openclaw/packages/llm-core/src/types";
import { nativeCapability, mediaBudget, imageTokens } from "./media-budget";
import { normalOutputTokens } from "./config";

export interface MediaResource {
  id: string;
  fileName: string;
  mimeType: string;
  mediaKind?: string | null;
  fileSize: number;
  r2Key: string;
  assetId?: string;
  sourceMetadata?: Record<string, unknown> | null;
}
export interface NativeMediaInput { model: Model; signal: AbortSignal }
class NativeLimit extends Error {}

export function resourceMime(attachment: Pick<MediaResource, "mimeType" | "mediaKind">): string {
  const mime = attachment.mimeType.split(";", 1)[0].toLowerCase();
  return attachment.mediaKind === "audio" && mime.startsWith("video/") ? mime.replace("video/", "audio/") : mime;
}

/** 附件和素材共用原件准备；返回 null 只表示原件本身不适合原生路由，存储/版本错误仍显式失败。 */
export async function prepareNativeMedia(attachment: MediaResource, input: NativeMediaInput): Promise<MediaContent | null> {
  input.signal.throwIfAborted();
  const mimeType = resourceMime(attachment);
  const capability = nativeCapability(input.model, mimeType);
  if (!capability) return null;
  const sizeProbe: MediaContent = { type: capability.kind, mimeType, fileName: attachment.fileName,
    budget: { bytes: attachment.fileSize, base64Chars: 4 * Math.ceil(attachment.fileSize / 3), estimatedTokens: 0, basis: "对象记录字节数" } };
  if (!mediaBudget(input.model, [sizeProbe]).fits) return null;
  try {
    input.signal.throwIfAborted();
    const response = await fetch(presignedGet(attachment.r2Key, 300), {
      signal: input.signal,
    });
    if (!response.ok || !response.body) throw new Error("原件读取失败");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        input.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > attachment.fileSize)
          throw new Error("原件体积超过记录，已停止读取");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const object = { body: Buffer.concat(chunks, total) };
    input.signal.throwIfAborted();
    if (!object || object.body.length !== attachment.fileSize)
      throw new Error("原件读取失败或大小不符");
    const data = object.body;
    const budget: NonNullable<MediaContent["budget"]> = {
      bytes: data.length,
      base64Chars: 4 * Math.ceil(data.length / 3),
      estimatedTokens: capability.tokenEstimate.minimum,
      basis: "实际媒体尺寸/页数/时长的保守估算",
    };
    if (capability.kind === "image") {
      const dimensions = imageSize(data);
      if (
        !dimensions.width ||
        !dimensions.height ||
        capability.maxPixels !== undefined && dimensions.width * dimensions.height > capability.maxPixels ||
        capability.maxDimension !== undefined && Math.max(dimensions.width ?? 0, dimensions.height ?? 0) > capability.maxDimension
      )
        throw new NativeLimit("无法读取图片尺寸或超过像素限制");
      const detectedMime =
        dimensions.type === "jpg" ? "image/jpeg" : `image/${dimensions.type}`;
      if (detectedMime !== mimeType)
        throw new Error("原件图片格式与记录不符");
      budget.width = dimensions.width;
      budget.height = dimensions.height;
      budget.estimatedTokens = imageTokens(capability, dimensions.width, dimensions.height);
    } else if (capability.kind === "file") {
      const doc = await parsePdf(data);
      budget.pages = doc.stats.pageCount;
      if (budget.pages > capability.maxPages!)
        throw new NativeLimit("PDF 页数超过原生预算");
      budget.estimatedTokens =
        budget.pages * capability.tokenEstimate.perPage! +
        Math.ceil(
          doc.pages.reduce(
            (n, page) =>
              n + page.lines.reduce((m, line) => m + line.text.length, 0),
            0,
          ) / 3,
        );
    } else {
      // 只接收本地容器，排除可能继续拉取远端分片的播放列表格式；不解码帧。
      const mediaInput = new Input({
        source: new BufferSource(new Uint8Array(data)),
        formats: [MP4, QTFF, WEBM, WAVE, MP3, OGG, FLAC],
      });
      const cancel = () => mediaInput.dispose();
      input.signal.addEventListener("abort", cancel, { once: true });
      try {
        input.signal.throwIfAborted();
        const duration = await mediaInput.computeDuration(undefined, {
          skipLiveWait: true,
        });
        if (
          !duration ||
          !Number.isFinite(duration) ||
          duration > capability.maxDurationSeconds!
        )
          throw new NativeLimit("媒体时长未知或超过预算");
        if (capability.kind === "video") {
          const track = await mediaInput.getPrimaryVideoTrack();
          if (
            !track ||
            track.displayWidth * track.displayHeight > capability.maxPixels!
          )
            throw new NativeLimit("视频轨道或分辨率不在原生预算内");
          budget.width = track.displayWidth;
          budget.height = track.displayHeight;
        } else if (!(await mediaInput.getPrimaryAudioTrack()))
          throw new Error("原件没有可读取的音轨");
        budget.durationSeconds = duration;
        budget.estimatedTokens = Math.max(
          budget.estimatedTokens,
          Math.ceil(duration * capability.tokenEstimate.perSecond!),
        );
      } finally {
        input.signal.removeEventListener("abort", cancel);
        mediaInput.dispose();
      }
    }
    const result: MediaContent = {
      type: capability.kind,
      ...(attachment.assetId ? { assetId: attachment.assetId } : { attachmentId: attachment.id }),
      fileName: attachment.fileName,
      mimeType,
      data: data.toString("base64"),
      source: attachment.assetId
        ? { kind: "asset", fileId: attachment.id, sha256: createHash("sha256").update(data).digest("hex") }
        : { kind: "attachment", sha256: createHash("sha256").update(data).digest("hex") },
      budget,
    };
    const window = Math.min(input.model.contextWindow, input.model.contextTokens ?? input.model.contextWindow);
    if (budget.estimatedTokens + normalOutputTokens(input.model) > window) return null;
    return result;
  } catch (error) {
    input.signal.throwIfAborted();
    if (error instanceof NativeLimit) return null;
    throw new Error(`${attachment.fileName}：原生输入准备失败（${error instanceof Error ? error.message : "读取失败"}）`);
  }
}
