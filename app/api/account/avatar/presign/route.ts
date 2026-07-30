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

  // Overwrite the same key each time so old avatar is replaced.
  const r2Key = `avatars/${session.userId}/avatar`;
  const { url } = presignedPut(r2Key, mimeType, 900);

  return Response.json({ uploadUrl: url, r2Key });
}
