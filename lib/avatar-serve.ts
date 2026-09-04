import sharp from "sharp";
import { getR2Object, putR2Object, deleteR2Object } from "./r2";
import type { AvatarSize } from "./avatar-url";

/** 头像 URL 的 `?s=` 参数 → 变体尺寸；非法/缺省一律回落 128。 */
export function parseAvatarSize(raw: string | null): AvatarSize {
  return raw === "512" ? 512 : 128;
}

function variantKey(key: string, size: AvatarSize): string {
  return `${key}@${size}.webp`;
}

/**
 * 取头像的缩放变体，懒生成：变体不存在时拉原图 → sharp 缩放存回 R2 → 返回。
 * 存量头像（改造前上传的）第一次被请求时就地补齐，无需回填脚本；并发重复
 * 生成是幂等覆盖，无害。原图不存在返回 null（调用方走外链兜底）。
 * sharp 失败（损坏文件等）降级返回原图，显示不空窗。
 */
export async function getAvatarVariant(
  key: string,
  size: AvatarSize,
): Promise<{ body: Buffer; contentType: string } | null> {
  const vKey = variantKey(key, size);
  const cached = await getR2Object(vKey);
  if (cached) return { body: cached.body, contentType: "image/webp" };

  const original = await getR2Object(key);
  if (!original) return null;

  try {
    // animated: true 保留 GIF/WebP 动图（头像允许上传 GIF）
    const resized = await sharp(original.body, { animated: true })
      .resize(size, size, { fit: "cover" })
      .webp({ quality: 82 })
      .toBuffer();
    // 变体写回失败不影响本次响应，下次请求重试
    putR2Object(vKey, resized, "image/webp").catch((e) => {
      console.warn(`[avatar-variant] cache write failed (${vKey}):`, e);
    });
    return { body: resized, contentType: "image/webp" };
  } catch (e) {
    console.warn(`[avatar-variant] resize failed (${key}); serving original:`, e);
    return { body: original.body, contentType: original.contentType ?? "image/jpeg" };
  }
}

/**
 * 换头像后清理旧 R2 对象（原图 + 两档变体）。key 版本化后不清会积垃圾。
 * 尽力而为：失败只留日志，不影响主流程。
 */
export async function deleteAvatarObjects(oldValue: string | null | undefined): Promise<void> {
  if (!oldValue || oldValue.startsWith("http")) return;
  const keys = [oldValue, variantKey(oldValue, 128), variantKey(oldValue, 512)];
  await Promise.all(keys.map((k) =>
    deleteR2Object(k).catch((e) => console.warn(`[avatar-cleanup] delete failed (${k}):`, e)),
  ));
}
