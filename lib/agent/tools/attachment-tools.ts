import { getReadyAttachmentForSession } from "@/lib/agent/attachment-db";
import { getR2Object } from "@/lib/r2";
import { neutralizeInjectionTags } from "@/lib/agent/agent-injection-safety";
import { attachmentDocRead, attachmentFileOcr } from "./doc-tools";
import { preflightAttachment } from "@/lib/mmp/attachment-preflight";

const TEXT_MAX_BYTES = 1024 * 1024;
const TEXT_MAX_CHARS = 80_000;

export async function readSessionAttachment(
  userId: string,
  productionId: string | null,
  sessionId: string | null,
  input: {
    attachmentId: string;
    mode?: "preflight" | "outline" | "read" | "search" | "ocr";
    ranges?: Array<{ from: number; to: number }>;
    query?: string;
    pages?: number[];
    tier?: "fast" | "full";
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<string> {
  if (!sessionId) return "当前运行没有会话上下文，无法读取临时附件。";
  const attachment = await getReadyAttachmentForSession(input.attachmentId, sessionId, userId);
  if (!attachment) return "没有找到该临时附件，或它不属于当前会话。";
  const lower = attachment.fileName.toLowerCase();
  const ref = {
    fileId: attachment.id,
    r2Key: attachment.r2Key,
    fileSize: attachment.fileSize,
    fileName: attachment.fileName,
  };
  if (lower.endsWith(".docx") || lower.endsWith(".pdf")) {
    if (input.mode === "ocr") {
      return attachmentFileOcr(userId, productionId, ref, attachment.mimeType, input.pages ?? [1], {
        tier: input.tier,
        sessionId,
        signal,
      });
    }
    return attachmentDocRead(ref, {
      mode: input.mode === "read" || input.mode === "search" ? input.mode : "outline",
      ranges: input.ranges,
      query: input.query,
      limit: input.limit,
    }, { sessionId });
  }
  const mediaKind = attachment.mediaKind ?? /^(audio|image|video)\//.exec(attachment.mimeType)?.[1] ??
    ((/\.(png|jpe?g|tiff?|webp)$/.test(lower)) ? "image"
      : (/\.(mp3|wav|flac|aiff?|m4a|ogg)$/.test(lower)) ? "audio"
        : (/\.(mp4|webm|mov|mkv)$/.test(lower)) ? "video" : null);
  if (mediaKind && input.mode !== "ocr") {
    const preflight = await preflightAttachment({
      mediaKind,
      attachmentId: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      r2Key: attachment.r2Key,
    }, { signal });
    return preflight.status === "ok"
      ? preflight.renderedDigest
      : neutralizeInjectionTags(`《${attachment.fileName}》${preflight.reason}`);
  }
  if (mediaKind === "image") {
    return attachmentFileOcr(userId, productionId, ref, attachment.mimeType, [1], {
      tier: input.tier,
      sessionId,
      signal,
    });
  }
  if (attachment.mimeType.startsWith("text/") || /\.(md|txt|csv|json|xml|yaml|yml|log)$/.test(lower)) {
    if (attachment.fileSize > TEXT_MAX_BYTES) return `《${neutralizeInjectionTags(attachment.fileName)}》超过纯文本单次读取上限 1 MB。`;
    const object = await getR2Object(attachment.r2Key);
    if (!object) return "附件原件不存在，请让用户重新上传。";
    const text = object.body.toString("utf8").replace(/\u0000/g, "�");
    const clipped = text.length > TEXT_MAX_CHARS ? `${text.slice(0, TEXT_MAX_CHARS)}\n…（已截断）` : text;
    return neutralizeInjectionTags(`《${attachment.fileName}》：\n${clipped}`);
  }
  if (mediaKind === "audio") {
    return neutralizeInjectionTags(`《${attachment.fileName}》是音频附件，原件已保留在当前会话中；当前没有可显式调用的音频读取能力。`);
  }
  return neutralizeInjectionTags(`《${attachment.fileName}》（${attachment.mimeType}，${attachment.fileSize} bytes）的原件已保留，但当前没有适合该格式的读取器。`);
}
