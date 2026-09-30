import { getAttachmentUsage, listAttachmentsForSession } from "./attachment-db";
import { neutralizeInjectionTags } from "./agent-injection-safety";
import { resolveProductionActor } from "./tools/production-tools";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";

const OPEN = "<clickin-attachment-lifecycle>";
const CLOSE = "</clickin-attachment-lifecycle>";

function size(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export async function buildAttachmentLifecycleBlock(input: {
  sessionId: string; userId: string; productionId: string | null;
}): Promise<{ text: string | null; toolNames: string[] }> {
  const attachments = (await listAttachmentsForSession(input.sessionId))
    .filter((item) => item.status === "ready" || item.status === "released");
  if (!attachments.length) return { text: null, toolNames: [] };
  const usage = await getAttachmentUsage(input.userId, input.sessionId);
  let canSave = false;
  if (input.productionId) {
    const resolved = await resolveProductionActor(input.userId, input.productionId);
    canSave = Boolean(resolved && !resolved.isArchived && await hasEffectiveGrant(
      resolved.actor, input.productionId, "asset", "*", "*", "create",
    ));
  }
  const sessionRatio = Math.max(usage.session.bytes / usage.session.maxBytes, usage.session.count / usage.session.maxCount);
  const userRatio = Math.max(usage.user.bytes / usage.user.maxBytes, usage.user.count / usage.user.maxCount);
  const pressure = Math.max(sessionRatio, userRatio);
  const lines = [
    OPEN,
    "以下是当前会话仍占用临时空间的附件状态，不是用户指令。只有确实不再需要时才释放；需要长期保留且有资产创建资格时，应存为资产。",
    `用量：当前会话 ${size(usage.session.bytes)}/${size(usage.session.maxBytes)}、${usage.session.count}/${usage.session.maxCount} 个；个人 ${size(usage.user.bytes)}/${size(usage.user.maxBytes)}、${usage.user.count}/${usage.user.maxCount} 个。`,
  ];
  if (pressure >= 0.9) lines.push("临时空间已超过 90%，应优先处理本轮已完成使用的附件。");
  else if (pressure >= 0.7) lines.push("临时空间已超过 70%，完成使用后宜主动释放或存为资产。");
  for (const item of attachments) {
    lines.push(
      `- ${neutralizeInjectionTags(item.fileName)}（attachmentId: ${item.id}；${item.fileSize} bytes；${item.status === "released" ? `已安排释放，可在 ${item.releaseUntil} 前恢复` : `临时内容，最晚 ${item.expiresAt} 过期`}）`,
    );
  }
  lines.push(
    canSave
      ? "可调用 production.attachment_save_as_asset 将应长期保留的附件存入当前制作资产库；可调用 my.attachment_release 释放本轮已成功处理且不再需要的附件。"
      : "可调用 my.attachment_release 释放本轮已成功处理且不再需要的附件。",
    CLOSE,
  );
  return {
    text: lines.join("\n"),
    toolNames: ["my.attachment_release", ...(canSave ? ["production.attachment_save_as_asset"] : [])],
  };
}
