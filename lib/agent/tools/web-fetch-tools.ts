import {
  AGENT_ATTACHMENT_MAX_BYTES,
  createPendingAttachment,
  markAttachmentReady,
  scheduleAttachmentDeletion,
  type AgentAttachment,
} from "@/lib/agent/attachment-db";
import { putR2ObjectStream } from "@/lib/r2";
import { WebToolError, type FetchedBinary } from "@/lib/agent/runtime/web-tools";

export type SavedWebAttachment = {
  attachment: AgentAttachment;
  requestedUrl: string;
  finalUrl: string;
  reused: boolean;
};

export async function saveWebFetchedAttachment(input: {
  userId: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  binary: FetchedBinary;
}): Promise<SavedWebAttachment> {
  if (input.binary.contentLength !== null && input.binary.contentLength > AGENT_ATTACHMENT_MAX_BYTES) {
    await input.binary.body.cancel().catch(() => {});
    throw new WebToolError("远端文件超过会话附件单文件 50 MB 上限。");
  }
  const mediaKind = /^(audio|image|video)\//.exec(input.binary.mimeType)?.[1] ?? null;
  let attachment: AgentAttachment;
  try {
    attachment = await createPendingAttachment({
      sessionId: input.sessionId,
      userId: input.userId,
      fileName: input.binary.fileName,
      mimeType: input.binary.mimeType,
      mediaKind,
      // 未知长度按单文件上限预占，防并发 chunked 响应绕过累计配额；完成后按实长校准。
      fileSize: input.binary.contentLength ?? AGENT_ATTACHMENT_MAX_BYTES,
      source: {
        kind: "web_fetch",
        runId: input.runId,
        toolCallId: input.toolCallId,
        url: input.binary.requestedUrl,
        finalUrl: input.binary.url,
      },
    });
  } catch (err) {
    await input.binary.body.cancel().catch(() => {});
    if (err instanceof Error && [403, 413].includes((err as { status?: number }).status ?? 0)) {
      throw new WebToolError(err.message);
    }
    throw err;
  }
  if (attachment.status === "ready") {
    await input.binary.body.cancel().catch(() => {});
    return { attachment, requestedUrl: input.binary.requestedUrl, finalUrl: input.binary.url, reused: true };
  }

  const counted = limitStream(input.binary.body, AGENT_ATTACHMENT_MAX_BYTES);
  try {
    await putR2ObjectStream(attachment.r2Key, counted.stream, attachment.mimeType);
    const ready = await markAttachmentReady(attachment.id, input.sessionId, input.userId, counted.size());
    if (!ready) throw new Error("附件记录在抓取完成前已不可用");
    return { attachment: ready, requestedUrl: input.binary.requestedUrl, finalUrl: input.binary.url, reused: false };
  } catch (err) {
    await scheduleAttachmentDeletion(attachment.id, input.sessionId, input.userId).catch(() => {});
    if (err instanceof AttachmentTooLargeError) {
      throw new WebToolError("远端文件超过会话附件单文件 50 MB 上限。");
    }
    console.warn(`[web.fetch] 远端附件保存失败：${err instanceof Error ? err.message : String(err)}`);
    throw new WebToolError("远端文件抓取或附件保存失败。");
  }
}

export function formatSavedWebAttachment(saved: SavedWebAttachment): string {
  const { attachment } = saved;
  return [
    saved.reused ? "该文件已在本轮抓取，复用现有会话附件。" : "已将远端文件保存为当前会话的临时附件。",
    `attachmentId：${attachment.id}`,
    `文件名：${attachment.fileName}`,
    `类型：${attachment.mimeType}`,
    `大小：${attachment.fileSize} bytes`,
    `来源：${saved.finalUrl}`,
    "可用 my.attachment_read 或匹配的 MMP 附件能力继续处理；需要长期保留时再存为项目资产。",
  ].join("\n");
}

class AttachmentTooLargeError extends Error {}

function limitStream(body: ReadableStream<Uint8Array>, maxBytes: number): {
  stream: ReadableStream<Uint8Array>;
  size: () => number;
} {
  const reader = body.getReader();
  let bytes = 0;
  return {
    stream: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { controller.close(); return; }
          bytes += next.value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel().catch(() => {});
            controller.error(new AttachmentTooLargeError());
            return;
          }
          controller.enqueue(next.value);
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel(reason) { await reader.cancel(reason).catch(() => {}); },
    }),
    size: () => bytes,
  };
}
