import type { AgentMessage } from "../../../vendor/openclaw/packages/agent-core/src/types";
import type { MediaContent } from "../../../vendor/openclaw/packages/llm-core/src/types";
import { getReadyAttachments, listAttachmentsForSession, recordAttachmentAccess } from "../attachment-db";
import { resolveReadableAsset } from "../tools/doc-tools";
import { neutralizeInjectionTags } from "../agent-injection-safety";
import { mediaIdentity } from "./media-budget";
import { prepareNativeMedia, type MediaResource } from "./model-media";
import type { MediaInput } from "./model-attachments";

function mediaParts(messages: AgentMessage[]): MediaContent[] {
  return messages.flatMap((message) => message.role !== "assistant" && "content" in message && Array.isArray(message.content)
    ? message.content.filter((part): part is MediaContent => part.type !== "text") : []);
}

/** 只刷新权限与对象状态时保留原件引用，让不匹配先进入 compaction，而不是先失败或隐式预检。 */
async function resolveMessages(messages: AgentMessage[], input: MediaInput, originals: boolean): Promise<AgentMessage[]> {
  input.signal.throwIfAborted();
  const references = messages.flatMap((message) => message.role === "compactionSummary"
    ? (message.details as { mediaReferences?: MediaContent[] } | undefined)?.mediaReferences ?? [] : []);
  const parts = mediaParts(messages);
  if (!parts.length && !references.length) return messages;
  const states = new Map((await listAttachmentsForSession(input.sessionId)).map((item) => [item.id, item]));
  const ids = [...new Set([...parts, ...references].flatMap((part) => part.attachmentId ? [part.attachmentId] : []))];
  const ready = new Map((await getReadyAttachments(ids, input.sessionId, input.userId)).map((item) => [item.id, item]));
  const resources = new Map<string, MediaResource>();
  const statuses = new Map<string, string>();
  for (const part of [...parts, ...references]) {
    const key = mediaIdentity(part);
    if (statuses.has(key)) continue;
    if (part.attachmentId) {
      const attachment = ready.get(part.attachmentId);
      if (attachment) {
        resources.set(key, attachment);
        statuses.set(key, "原件仍在会话附件中；需要复核时调用 my.attachment_read。");
      } else {
        const state = states.get(part.attachmentId);
        statuses.set(key, state?.status === "promoted"
          ? `已存为素材 assetId=${state.promotedAssetId}，按当前权限调用 production.asset_read。`
          : state?.status === "released" ? "附件已安排释放，用户可在宽限期内恢复后再读取。"
            : "原件当前不可读，历史分析仍可参考，不得声称本次重新读取。");
      }
    } else if (part.assetId && input.productionId) {
      const got = await resolveReadableAsset(input.userId, input.productionId, part.assetId);
      if (typeof got === "string") statuses.set(key, `原件当前不可读：${got}`);
      else if (part.source?.kind === "asset" && part.source.fileId !== got.file.id)
        throw new Error("原件版本变化，不能替换历史证据");
      else if (got.file.fileSize == null) statuses.set(key, "素材原件缺少文件大小，无法安全读取。");
      else {
        resources.set(key, { id: got.file.id, assetId: part.assetId, fileName: got.asset.fileName,
          mimeType: got.asset.mimeType ?? "application/octet-stream", fileSize: got.file.fileSize, r2Key: got.file.r2Key });
        statuses.set(key, "原件仍在素材库中；需要复核时调用 production.asset_read。");
      }
    } else statuses.set(key, "缺少可授权的原件身份，不能恢复。");
  }
  const prepared = new Map<string, MediaContent>();
  for (const part of parts) {
    const key = mediaIdentity(part);
    const resource = resources.get(key);
    if (!resource || prepared.has(key)) continue;
    const metadata = resource.sourceMetadata;
    // 已校验生成物的测量值可先用于适配检查；不支持该模态的目标模型没有原生 token 成本。
    const measured = part.budget ?? (part.type === "image" && typeof metadata?.width === "number" && typeof metadata.height === "number"
      ? { bytes: resource.fileSize, base64Chars: 4 * Math.ceil(resource.fileSize / 3), width: metadata.width, height: metadata.height,
        estimatedTokens: 0, basis: "生成物已校验的字节与像素；原生 token 在原件准备时按执行模型计算" } : undefined);
    const current = measured ? { ...part, budget: measured } : part;
    if ((!originals && measured) || part.data && measured) { prepared.set(key, current); continue; }
    const native = await prepareNativeMedia(resource, input);
    if (!native) {
      // 有实测预算的历史原件保留至能力判定；未经分析的新产物仍以准确引用供主动读取。
      if (measured) prepared.set(key, current);
      continue;
    }
    if (part.source && part.source.sha256 !== native.source?.sha256) throw new Error("原件版本变化，不能替换历史证据");
    prepared.set(key, native);
    if (originals && part.attachmentId) await recordAttachmentAccess(input.runId, [part.attachmentId], "read");
  }
  const sent = new Set<string>();
  return messages.map((message) => {
    if (message.role === "compactionSummary") return { ...message,
      summary: message.summary + (references.length ? "\n【媒体回查状态】\n" + references.map((part) =>
        neutralizeInjectionTags(`${part.fileName ?? "媒体"}（${part.attachmentId ? `attachmentId=${part.attachmentId}` : `assetId=${part.assetId}`}）：${statuses.get(mediaIdentity(part))}`)).join("\n") : "") };
    if (message.role === "assistant" || !("content" in message) || !Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map((part) => {
      if (part.type === "text") return part;
      const key = mediaIdentity(part);
      const restored = prepared.get(key);
      if (restored && !sent.has(key)) { sent.add(key); return restored; }
      return { type: "text" as const, text: neutralizeInjectionTags(
        `附件/素材 ${part.fileName ?? ""}（${part.attachmentId ? `attachmentId=${part.attachmentId}` : `assetId=${part.assetId}`}）：${restored ? "原件已在本请求提供，不重复发送。" : statuses.get(key)}；摘要或预检不等于本次重读原件。`), };
    }) };
  });
}

export function refreshMediaReferences(messages: AgentMessage[], input: MediaInput) {
  return resolveMessages(messages, input, false);
}
export function restoreModelMedia(messages: AgentMessage[], input: MediaInput) {
  return resolveMessages(messages, input, true);
}

/** 以本次实际内容为准；清单、摘要或历史已读不能冒充完整覆盖。 */
export async function attachmentReadNeeded(messages: AgentMessage[], input: MediaInput, allowedIds?: string[]) {
  const rows = await listAttachmentsForSession(input.sessionId);
  const ids = rows.filter((item) => !allowedIds || allowedIds.includes(item.id)).map((item) => item.id);
  const ready = await getReadyAttachments(ids, input.sessionId, input.userId);
  const covered = new Set(mediaParts(messages).filter((part) => part.data).map((part) => part.attachmentId));
  for (const message of messages) if (message.role === "toolResult" && !message.isError) {
    for (const id of (message.details as { completeAttachmentIds?: string[] } | undefined)?.completeAttachmentIds ?? []) covered.add(id);
  }
  return ready.some((item) => !covered.has(item.id));
}
