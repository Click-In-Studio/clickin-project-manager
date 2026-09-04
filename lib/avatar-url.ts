/**
 * 头像 URL 构造（前后端同构，无服务端依赖）。
 *
 * 缓存策略的约定整体在这里成立：R2 key 每次上传都换新（presign 路由生成
 * `avatar-<ts>` 后缀），存进 user_profile.avatar_url / production.avatar_url。
 * 前端从存量值派生 `?v=`，代理路由则返回 immutable 强缓存——URL 变即新图，
 * URL 不变浏览器一年内不回源。改缓存语义时三处（这里、两个 avatar GET 路由）
 * 必须一起动。
 */
import { BASE_PATH } from "./base-path";

/** 与显示尺寸对应的两档预生成变体；服务端 sharp 只认这两个值。 */
export type AvatarSize = 128 | 512;

/** 存量 avatar_url 值 → 短版本号（值变则变；无密码学要求）。 */
function rev(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * 用户头像 src。avatarUrl 是 DB 存量值：http 开头（飞书 CDN 等外链）直接用；
 * 否则视为 R2 key，走 session 鉴权的代理路由。
 */
export function userAvatarSrc(userId: string, avatarUrl: string | null | undefined, size: AvatarSize = 128): string | null {
  if (!avatarUrl) return null;
  if (avatarUrl.startsWith("http")) return avatarUrl;
  return `${BASE_PATH}/api/user/avatar/${userId}?v=${rev(avatarUrl)}&s=${size}`;
}

/** 演出头像 src。avatarUrl 为 null 表示未设置（调用方渲染首字兜底）。 */
export function productionAvatarSrc(productionId: string, avatarUrl: string | null | undefined, size: AvatarSize = 128): string | null {
  if (!avatarUrl) return null;
  if (avatarUrl.startsWith("http")) return avatarUrl;
  return `${BASE_PATH}/api/production/${productionId}/avatar?v=${rev(avatarUrl)}&s=${size}`;
}
