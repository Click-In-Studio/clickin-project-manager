/**
 * 头像上传审计账本（avatar_upload_audit，见 db/add-avatar-upload-audit.sql）。
 *
 * 头像 R2 key 版本化后，上传未提交的对象没有 DB 引用——不做自动 GC，
 * 但每一步都记账：presign 记 minted、PATCH 提交标记 committed、清旧标记
 * deleted。孤儿 = committed_at 与 deleted_at 皆空的过期行，随时可查可手清。
 */
import { randomBytes } from "node:crypto";
import { getPool } from "./pg";
import { deleteAvatarObjects } from "./avatar-serve";

function makeAuditId(): string {
  return `ava_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

/** presign 时记账。失败让 presign 一起失败——账本记不上就不该发上传凭证。 */
export async function recordAvatarUpload(
  kind: "user" | "production",
  subjectId: string,
  r2Key: string,
  uploaderId: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO avatar_upload_audit (id, r2_key, kind, subject_id, uploader_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [makeAuditId(), r2Key, kind, subjectId, uploaderId],
  );
}

/** PATCH 把 key 写进 avatar_url 时平账。外链/空值无账可平，直接返回。 */
export async function markAvatarCommitted(value: string | null | undefined): Promise<void> {
  if (!value || value.startsWith("http")) return;
  await getPool().query(
    `UPDATE avatar_upload_audit SET committed_at = now()
     WHERE r2_key = $1 AND committed_at IS NULL`,
    [value],
  );
}

/**
 * 清旧头像对象并平账（deleted_at 只在原图+变体全删成功时标记，删不净的
 * 留在账上继续算孤儿）。整体不抛，调用方 void 它是安全的。
 */
export async function cleanupAvatarObjects(oldValue: string | null | undefined): Promise<void> {
  if (!oldValue || oldValue.startsWith("http")) return;
  try {
    const allDeleted = await deleteAvatarObjects(oldValue);
    if (allDeleted) {
      await getPool().query(
        `UPDATE avatar_upload_audit SET deleted_at = now()
         WHERE r2_key = $1 AND deleted_at IS NULL`,
        [oldValue],
      );
    }
  } catch (e) {
    console.warn(`[avatar-cleanup] audit update failed (${oldValue}):`, e);
  }
}
