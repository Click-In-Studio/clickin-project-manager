import {
  getReadyAttachmentForSession,
  getAttachmentForSession,
  recordAttachmentAccess,
  releaseAttachmentForRun,
} from "@/lib/agent/attachment-db";
import { getPool } from "@/lib/pg";
import { getR2Object } from "@/lib/r2";
import { neutralizeInjectionTags } from "@/lib/agent/agent-injection-safety";
import { attachmentDocRead, attachmentFileOcr } from "./doc-tools";
import { preflightAttachment } from "@/lib/mmp/attachment-preflight";
import { resolveProductionActor } from "./production-tools";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
import { createAsset } from "@/lib/asset/db";
import { isAssetType, type AssetType } from "@/lib/asset/types";
import { enqueueAssetPostProcess } from "@/lib/job/asset-jobs";

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
  runId?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!sessionId) return "当前运行没有会话上下文，无法读取临时附件。";
  const attachment = await getReadyAttachmentForSession(input.attachmentId, sessionId, userId);
  if (!attachment) {
    const unavailable = await getAttachmentForSession(input.attachmentId, sessionId, userId);
    if (!unavailable) return "没有找到该临时附件，或它不属于当前会话。";
    if (unavailable.status === "released") return "该临时附件已安排释放；用户可在宽限期内从聊天记录恢复后再读取。";
    if (unavailable.status === "promoted") return `该临时附件已存为资产${unavailable.promotedAssetId ? `（资产 id: ${unavailable.promotedAssetId}）` : ""}，请改用资产读取工具。`;
    return "该临时附件已过期或正在清理，原件不再可读。";
  }
  const done = async (output: string) => {
    if (runId) await recordAttachmentAccess(runId, [attachment.id], "read");
    return output;
  };
  const lower = attachment.fileName.toLowerCase();
  const ref = {
    fileId: attachment.id,
    r2Key: attachment.r2Key,
    fileSize: attachment.fileSize,
    fileName: attachment.fileName,
  };
  // preflight 是通用 MMP 入口：不要先按宿主认识的文件种类分流。MMP 2.0
  // 会用 purpose + Content-Type 决定当前和未来的媒体能力。
  if (input.mode === "preflight") {
    const preflight = await preflightAttachment({
      attachmentId: attachment.id,
      mediaKind: attachment.mediaKind,
      mimeType: attachment.mimeType,
      r2Key: attachment.r2Key,
    }, { signal, usage: { userId, productionId } });
    return done(neutralizeInjectionTags(preflight.contextText));
  }
  if (lower.endsWith(".docx") || lower.endsWith(".pdf")) {
    if (input.mode === "ocr") {
      return done(await attachmentFileOcr(userId, productionId, ref, attachment.mimeType, input.pages ?? [1], {
        tier: input.tier,
        sessionId,
        signal,
      }));
    }
    return done(await attachmentDocRead(ref, {
      mode: input.mode === "read" || input.mode === "search" ? input.mode : "outline",
      ranges: input.ranges,
      query: input.query,
      limit: input.limit,
    }, { sessionId }));
  }
  const mediaKind = attachment.mediaKind ?? /^(audio|image|video)\//.exec(attachment.mimeType)?.[1] ??
    ((/\.(png|jpe?g|tiff?|webp)$/.test(lower)) ? "image"
      : (/\.(mp3|wav|flac|aiff?|m4a|ogg)$/.test(lower)) ? "audio"
        : (/\.(mp4|webm|mov|mkv)$/.test(lower)) ? "video" : null);
  if (mediaKind && input.mode !== "ocr") {
    const preflight = await preflightAttachment({
      attachmentId: attachment.id,
      mediaKind: attachment.mediaKind,
      mimeType: attachment.mimeType,
      r2Key: attachment.r2Key,
    }, { signal, usage: { userId, productionId } });
    return done(neutralizeInjectionTags(preflight.contextText));
  }
  if (mediaKind === "image") {
    return done(await attachmentFileOcr(userId, productionId, ref, attachment.mimeType, [1], {
      tier: input.tier,
      sessionId,
      signal,
    }));
  }
  if (attachment.mimeType.startsWith("text/") || /\.(md|txt|csv|json|xml|yaml|yml|log)$/.test(lower)) {
    if (attachment.fileSize > TEXT_MAX_BYTES) return `《${neutralizeInjectionTags(attachment.fileName)}》超过纯文本单次读取上限 1 MB。`;
    const object = await getR2Object(attachment.r2Key);
    if (!object) return "附件原件不存在，请让用户重新上传。";
    const text = object.body.toString("utf8").replace(/\u0000/g, "�");
    const clipped = text.length > TEXT_MAX_CHARS ? `${text.slice(0, TEXT_MAX_CHARS)}\n…（已截断）` : text;
    return done(neutralizeInjectionTags(`《${attachment.fileName}》：\n${clipped}`));
  }
  if (mediaKind === "audio") {
    return done(neutralizeInjectionTags(`《${attachment.fileName}》是音频附件，原件已保留在当前会话中；当前没有可显式调用的音频读取能力。`));
  }
  return done(neutralizeInjectionTags(`《${attachment.fileName}》（${attachment.mimeType}，${attachment.fileSize} bytes）的原件已保留，但当前没有适合该格式的读取器。`));
}

export async function releaseSessionAttachment(input: {
  userId: string; sessionId: string | null; runId: string | null; attachmentId: string;
}): Promise<string> {
  if (!input.sessionId || !input.runId) return "当前运行没有会话上下文，无法释放临时附件。";
  const attachment = await releaseAttachmentForRun({
    attachmentId: input.attachmentId, runId: input.runId, sessionId: input.sessionId, userId: input.userId,
  });
  return `已安排释放《${neutralizeInjectionTags(attachment.fileName)}》；释放宽限期内（最长 24 小时）用户仍可从聊天记录恢复。`;
}

export async function saveSessionAttachmentAsAsset(input: {
  userId: string; productionId: string; sessionId: string | null; attachmentId: string;
  assetType?: string; name?: string;
}): Promise<string> {
  if (!input.sessionId) return "当前运行没有会话上下文，无法保存临时附件。";
  const resolved = await resolveProductionActor(input.userId, input.productionId);
  if (!resolved) return "权限被拒绝：你不是该制作的成员。";
  if (resolved.isArchived) return "该制作已归档，无法创建资产。";
  if (!await hasEffectiveGrant(resolved.actor, input.productionId, "asset", "*", "*", "create")) {
    return "权限被拒绝：你没有创建资产的权限（asset */*@create）。";
  }
  if (input.assetType !== undefined && (!isAssetType(input.assetType) || input.assetType === "financial_document")) {
    return "资产类型无效；请省略 assetType 使用 reference，或传入普通资产类型（不能用 financial_document）。";
  }
  const assetType: AssetType = input.assetType ?? "reference";
  const client = await getPool().connect();
  type PromotionRow = { file_name: string; mime_type: string; r2_key: string; file_size: string; promoted_asset_id: string | null };
  let created: Awaited<ReturnType<typeof createAsset>> | null = null;
  let attachment: PromotionRow | null = null;
  try {
    await client.query("BEGIN");
    const locked = await client.query<PromotionRow>(
      `SELECT a.file_name, a.mime_type, a.r2_key, a.file_size, a.promoted_asset_id
       FROM agent_session_attachment a JOIN agent_session s ON s.id = a.session_id
       WHERE a.id = $1 AND a.session_id = $2 AND s.user_id = $3 FOR UPDATE OF a`,
      [input.attachmentId, input.sessionId, input.userId],
    );
    attachment = locked.rows[0] ?? null;
    if (!attachment) { await client.query("ROLLBACK"); return "没有找到该临时附件，或它不属于当前会话。"; }
    if (attachment.promoted_asset_id) {
      await client.query("COMMIT");
      return `该附件已经存为资产（资产 id: ${attachment.promoted_asset_id}）。`;
    }
    const state = await client.query<{ status: string; release_until: Date | null }>(
      `SELECT status, release_until FROM agent_session_attachment WHERE id = $1`, [input.attachmentId],
    );
    if (!state.rows[0] || !["ready", "released"].includes(state.rows[0].status)
        || (state.rows[0].status === "released" && (!state.rows[0].release_until || state.rows[0].release_until <= new Date()))) {
      await client.query("ROLLBACK");
      return "该临时附件已过期，不能再存为资产。";
    }
    created = await createAsset({
      productionId: input.productionId, uploaderUserId: input.userId, assetType,
      name: input.name?.trim() || null, fileName: attachment.file_name, mimeType: attachment.mime_type,
      storageType: "r2", r2Key: attachment.r2_key, fileSize: Number(attachment.file_size),
      listable: false,
    }, client);
    await client.query(
      `UPDATE agent_session_attachment SET status = 'promoted', promoted_asset_id = $2,
         release_until = NULL, expires_at = absolute_expires_at WHERE id = $1`,
      [input.attachmentId, created.asset.id],
    );
    await client.query(
      `UPDATE agent_attachment_object SET status = CASE WHEN kind = 'original' THEN 'transferred' ELSE 'delete_pending' END,
         next_attempt_at = CASE WHEN kind = 'original' THEN NULL ELSE now() END
       WHERE attachment_id = $1 AND status IN ('reserved','present','delete_pending','deleting')`, [input.attachmentId],
    );
    await client.query("COMMIT");
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
  await enqueueAssetPostProcess({
    assetFileId: created!.file.id, r2Key: attachment!.r2_key, mimeType: attachment!.mime_type,
    fileName: attachment!.file_name, fileSize: Number(attachment!.file_size),
  });
  return `已将《${neutralizeInjectionTags(attachment!.file_name)}》存为资产（资产 id: ${created!.asset.id}）。`;
}
