import type { Context, MediaContent, Model, NativeMediaCapability } from "../../../vendor/openclaw/packages/llm-core/src/types";

export function mediaAdapterAvailable(api: string, capability: NativeMediaCapability): boolean {
  return api === "google-generative-ai" ||
    api === "openai-completions" && ["image", "audio", "video"].includes(capability.kind);
}

export function nativeCapability(model: Model, mimeType: string, kind?: MediaContent["type"]) {
  return model.nativeMedia?.find((item) => (!kind || item.kind === kind) &&
    item.mimeTypes.includes(mimeType) && item.transports.includes("inline") && mediaAdapterAvailable(model.api, item));
}

export function mediaIdentity(part: MediaContent): string {
  return JSON.stringify([part.attachmentId, part.assetId, part.mimeType, part.source]);
}

export function requestMedia(messages: Context["messages"]): MediaContent[] {
  return messages.flatMap((message) => message.role !== "assistant" && Array.isArray(message.content)
    ? message.content.filter((part): part is MediaContent => part.type !== "text") : []);
}

/** 原件硬限制与完整请求载荷同源判定；不把 base64 字节误当成上下文 token。 */
export function mediaBudget(model: Model, parts: MediaContent[]) {
  const reasons: string[] = [];
  const counts = new Map<NativeMediaCapability, { bytes: number; count: number }>();
  let bytes = 0;
  let base64Chars = 0;
  let byteLimit = Infinity;
  let charLimit = Infinity;
  for (const part of parts) {
    const label = part.fileName ?? part.attachmentId ?? part.assetId ?? part.mimeType;
    const capability = nativeCapability(model, part.mimeType, part.type);
    if (!capability) { reasons.push(`${label}：目标模型未接入 ${part.mimeType}`); continue; }
    const measured = part.budget;
    if (!measured) { reasons.push(`${label}：缺少实测媒体预算`); continue; }
    const size = part.data ? Buffer.byteLength(part.data, "base64") : measured.bytes;
    const chars = part.data?.length ?? measured.base64Chars;
    const prior = counts.get(capability) ?? { bytes: 0, count: 0 };
    if (size > capability.maxBytes ||
      capability.maxPixels !== undefined && (measured.width ?? 0) * (measured.height ?? 0) > capability.maxPixels ||
      capability.maxPages !== undefined && (measured.pages ?? 0) > capability.maxPages ||
      capability.maxDurationSeconds !== undefined && (measured.durationSeconds ?? 0) > capability.maxDurationSeconds)
      reasons.push(`${label}：原件超过目标模型的单件限制`);
    if (prior.bytes + size > capability.maxRequestBytes || prior.count + 1 > capability.maxCount)
      reasons.push(`${label}：超过该模态的请求体积或数量预算`);
    counts.set(capability, { bytes: prior.bytes + size, count: prior.count + 1 });
    bytes += size;
    base64Chars += chars;
    byteLimit = Math.min(byteLimit, capability.maxRequestBytes);
    charLimit = Math.min(charLimit, capability.maxRequestBase64Chars);
  }
  if (bytes > byteLimit || base64Chars > charLimit) reasons.push("混合模态超过完整请求的媒体传输预算");
  return { fits: reasons.length === 0, reasons, bytes, base64Chars, count: parts.length };
}
