import type { MediaContent } from "../../../vendor/openclaw/packages/llm-core/src/types";
import type { AgentToolResult } from "../../../vendor/openclaw/packages/agent-core/src/types";
import { getAttachmentForSession, getReadyAttachmentForSession, recordAttachmentAccess } from "../attachment-db";
import { resolveReadableAsset } from "../tools/doc-tools";
import { readResourceText, type MediaReadOptions } from "../tools/media-read-tools";
import { neutralizeInjectionTags } from "../agent-injection-safety";
import { prepareNativeMedia, type MediaResource } from "./model-media";
import { runModelSelection } from "./model-settings-db";
import { resolveModel } from "./config";
import type { ToolContext } from "./tools";
import { acquire, release, currentAdmissionScope } from "./admission";
import { mediaIdentity } from "./media-budget";

function text(value: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: neutralizeInjectionTags(value) }], details: undefined };
}

/** 工具阶段的摘要也使用同一 LLM 准入门，不能绕过模型并发上限。 */
async function prepareRead(ctx: ToolContext, media: MediaContent, callId?: string) {
  const run = ctx.run!;
  if (!run.prepareMediaRead) return true;
  if (!currentAdmissionScope()) return run.prepareMediaRead(media);
  const ticket = await acquire(run.runId, `media-read:${callId ?? mediaIdentity(media)}`, "llm", run.signal);
  if (ticket.state === "done") return (ticket.result as { native: boolean }).native;
  try {
    const native = await run.prepareMediaRead(media);
    await release(ticket, "done", { native });
    return native;
  } catch (error) {
    await release(ticket, "failed");
    throw error;
  }
}

/** 两种来源只有授权和生命周期不同；默认读取先原生，历史占用由下一次请求边界统一压缩。 */
export async function readModelMedia(ctx: ToolContext, args: MediaReadOptions & { attachmentId?: string; assetId?: string }, callId?: string): Promise<AgentToolResult<unknown>> {
  const sessionId = ctx.run?.sessionId ?? null;
  let resource: MediaResource;
  if (args.attachmentId) {
    if (!sessionId) return text("当前运行没有会话上下文，无法读取临时附件。");
    const attachment = await getReadyAttachmentForSession(args.attachmentId, sessionId, ctx.userId);
    if (!attachment) {
      const row = await getAttachmentForSession(args.attachmentId, sessionId, ctx.userId);
      return text(!row ? "没有找到该临时附件，或它不属于当前会话。"
        : row.status === "promoted" ? `该附件已存为素材 assetId=${row.promotedAssetId}，请调用 production.asset_read。`
          : row.status === "released" ? "附件已安排释放，用户可在宽限期内从聊天记录恢复后再读取。"
            : "附件已过期或正在清理，原件当前不可读。");
    }
    resource = attachment;
  } else if (args.assetId && ctx.productionId) {
    const got = await resolveReadableAsset(ctx.userId, ctx.productionId, args.assetId);
    if (typeof got === "string") return text(got);
    if (got.file.fileSize == null) return text("素材原件缺少文件大小，无法安全读取。");
    resource = { id: got.file.id, assetId: args.assetId, fileName: got.asset.fileName,
      mimeType: got.asset.mimeType ?? "application/octet-stream", fileSize: got.file.fileSize, r2Key: got.file.r2Key };
  } else return text("缺少有效的附件或当前制作素材 id。");
  if (ctx.run && (!args.mode || args.mode === "read") && !args.ranges && !args.query) {
    const model = resolveModel((await runModelSelection(ctx.run.runId)).modelKey);
    const media = await prepareNativeMedia(resource, { model, signal: ctx.run.signal });
    if (media && await prepareRead(ctx, media, callId)) {
      if (args.attachmentId) await recordAttachmentAccess(ctx.run.runId, [args.attachmentId], "read");
      return { content: [{ type: "text", text: neutralizeInjectionTags(`原件已准备：${resource.fileName}；${args.attachmentId ? `attachmentId=${args.attachmentId}` : `assetId=${args.assetId}`}。原生输入将在下一次请求前检查完整预算；必要时先压缩其他历史。`) }, media], details: undefined };
    }
  }
  const fallback = await readResourceText(resource, args, { userId: ctx.userId, productionId: ctx.productionId,
    sessionId, signal: ctx.run?.signal });
  if (ctx.run && args.attachmentId) await recordAttachmentAccess(ctx.run.runId, [args.attachmentId], "read");
  return { content: [{ type: "text", text: fallback.text }], details: {
    completeAttachmentIds: fallback.complete && args.attachmentId ? [args.attachmentId] : [],
  } };
}
