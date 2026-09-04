import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { presignedPut } from "@/lib/r2";

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const body = await req.json() as { mimeType?: string };
  const mimeType = body.mimeType;
  if (!mimeType || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType)) {
    return Response.json({ error: "不支持的文件类型" }, { status: 400 });
  }
  // Client enforces 5 MB before calling this endpoint; R2 bucket policy enforces server-side.

  // key 每次上传换新（时间戳后缀）：avatar GET 路由靠「换头像即换 key」才能对
  // 200 响应给 immutable 强缓存。旧对象在 profile PATCH 提交新 key 时清理。
  // 已知取舍：上传后未提交（放弃/崩溃）的对象成为孤儿，无人触发清理——
  // 量级受限于「presign 过但没保存」的次数 × 头像体积，先不做 GC。
  const r2Key = `avatars/${session.userId}/avatar-${Date.now().toString(36)}`;
  const { url } = presignedPut(r2Key, mimeType, 900);

  return Response.json({ uploadUrl: url, r2Key });
}
