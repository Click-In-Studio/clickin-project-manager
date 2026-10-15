import {
  releaseAttachmentForRun,
} from "@/lib/agent/attachment-db";
import { getPool } from "@/lib/pg";
import { neutralizeInjectionTags } from "@/lib/agent/agent-injection-safety";
import { resolveProductionActor } from "./production-tools";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
import { createAsset } from "@/lib/asset/db";
import { isAssetType, type AssetType } from "@/lib/asset/types";
import { enqueueAssetPostProcess } from "@/lib/job/asset-jobs";

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
