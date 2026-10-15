import { getR2Object } from "@/lib/r2";
import { preflightAttachment } from "@/lib/mmp/attachment-preflight";
import { neutralizeInjectionTags } from "../agent-injection-safety";
import { attachmentDocRead, attachmentFileOcr } from "./doc-tools";
import type { MediaResource } from "../runtime/model-media";

export interface MediaReadOptions {
  mode?: "outline" | "read" | "search" | "ocr";
  ranges?: Array<{ from: number; to: number }>;
  query?: string;
  pages?: number[];
  tier?: "fast" | "full";
  limit?: number;
}

/** 非原生读取共用现有文档/MMP 能力；完整文本与概览、片段、预检严格区分。 */
export async function readResourceText(resource: MediaResource, options: MediaReadOptions,
  context: { userId: string; productionId: string | null; sessionId: string | null; signal?: AbortSignal },
): Promise<{ text: string; complete: boolean }> {
  const lower = resource.fileName.toLowerCase();
  const file = { fileId: resource.id, r2Key: resource.r2Key, fileSize: resource.fileSize, fileName: resource.fileName };
  if (lower.endsWith(".docx") || lower.endsWith(".pdf")) {
    const text = options.mode === "ocr"
      ? await attachmentFileOcr(context.userId, context.productionId, file, resource.mimeType, options.pages ?? [1], {
        tier: options.tier, sessionId: context.sessionId, signal: context.signal,
      })
      : await attachmentDocRead(file, { mode: options.mode === "search" ? "search" : options.mode === "read" && options.ranges?.length ? "read" : "outline",
        ranges: options.ranges, query: options.query, limit: options.limit }, { sessionId: context.sessionId });
    return { text, complete: false };
  }
  const mediaKind = resource.mediaKind ?? /^(audio|image|video)\//.exec(resource.mimeType)?.[1];
  if (mediaKind === "image" && options.mode === "ocr") return {
    text: await attachmentFileOcr(context.userId, context.productionId, file, resource.mimeType, options.pages ?? [1], {
      tier: options.tier, sessionId: context.sessionId, signal: context.signal,
    }), complete: false,
  };
  if (mediaKind) {
    const outcome = await preflightAttachment({ attachmentId: resource.id, mediaKind: resource.mediaKind,
      mimeType: resource.mimeType, r2Key: resource.r2Key }, {
      signal: context.signal, usage: { userId: context.userId, productionId: context.productionId },
    });
    return { text: neutralizeInjectionTags(outcome.contextText) + "\n以上为 MMP 解析证据，当前模型未原生读取该原件。", complete: false };
  }
  if (resource.mimeType.startsWith("text/") || /\.(md|txt|csv|json|xml|yaml|yml|log)$/.test(lower)) {
    if (resource.fileSize > 1024 * 1024) return { text: "纯文本超过单次读取上限 1 MB，请缩小文件范围。", complete: false };
    const object = await getR2Object(resource.r2Key);
    if (!object) return { text: "原件不存在，无法读取。", complete: false };
    const text = object.body.toString("utf8").replace(/\u0000/g, "�");
    return { text: neutralizeInjectionTags(`《${resource.fileName}》：\n` + (text.length > 80_000 ? text.slice(0, 80_000) + "\n…（已截断）" : text)),
      complete: text.length <= 80_000 };
  }
  return { text: neutralizeInjectionTags(`《${resource.fileName}》（${resource.mimeType}）原件仍保留，但当前没有适合该格式的读取器。`), complete: false };
}
