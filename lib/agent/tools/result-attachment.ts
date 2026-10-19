import { createPendingAttachment, markAttachmentReady, scheduleAttachmentDeletion, AGENT_ATTACHMENT_MAX_BYTES } from "../attachment-db";
import { putR2Object, getR2Object } from "@/lib/r2";
import { neutralizeInjectionTags } from "../agent-injection-safety";
import { formatTextWindow } from "./text-window";

type Input = Omit<Parameters<typeof createPendingAttachment>[0], "fileSize" | "mediaKind"> & { text: string };
/** 先成功保存完整结果，再允许调用方缩减；失败显式抛出，沿用会话附件配额、所有权与回收。 */
export async function saveTextResult(input: Input) {
  const bytes = Buffer.from(input.text, "utf8");
  if (bytes.length > AGENT_ATTACHMENT_MAX_BYTES) throw new Error("完整文本超过附件 50 MiB 上限，未返回残缺材料。");
  const attachment = await createPendingAttachment({ ...input, fileSize: bytes.length });
  if (attachment.status === "ready") {
    const stored = await getR2Object(attachment.r2Key);
    if (!stored) throw new Error("已保存材料不存在，无法复用。");
    return { attachment, text: stored.body.toString("utf8") };
  }
  try {
    await putR2Object(attachment.r2Key, bytes, input.mimeType);
    const ready = await markAttachmentReady(attachment.id, input.sessionId, input.userId, bytes.length);
    if (!ready) throw new Error("完整文本附件保存未完成");
    return { attachment: ready, text: input.text };
  } catch (error) {
    await scheduleAttachmentDeletion(attachment.id, input.sessionId, input.userId).catch(() => {});
    throw error;
  }
}
export function savedTextPreview(saved: Awaited<ReturnType<typeof saveTextResult>>, length = 4000): string {
  const a = saved.attachment;
  return neutralizeInjectionTags(`完整材料已保存：attachmentId=${a.id}；文件=${a.fileName}；有效至=${a.expiresAt}。\n`
    + `用 my.attachment_read 的 mode=read + window={offset,length} 续读，mode=search + query 搜索；附件仅在当前会话权限与有效期内可用。\n`
    + formatTextWindow(saved.text, { length }));
}
