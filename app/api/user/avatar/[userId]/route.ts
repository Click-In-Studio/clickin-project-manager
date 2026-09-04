import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { isR2Configured } from "@/lib/r2";
import { getAvatarVariant, parseAvatarSize } from "@/lib/avatar-serve";
import { getPool } from "@/lib/pg";

type Ctx = { params: Promise<{ userId: string }> };

// 强缓存的前提：R2 key 每次上传换新，前端 URL 从存量值派生 ?v=（lib/avatar-url.ts），
// 换头像即换 URL。302 外链兜底给短缓存——飞书同步可能悄悄换 URL，不配 immutable。
const IMMUTABLE = "private, max-age=31536000, immutable";

function redirect(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: url, "Cache-Control": "private, max-age=86400" },
  });
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return new Response(null, { status: 401 });

  const { userId } = await ctx.params;
  const size = parseAvatarSize(req.nextUrl.searchParams.get("s"));

  const res = await getPool().query<{ avatar_url: string | null }>(
    `SELECT COALESCE(
       (SELECT avatar_url FROM user_profile WHERE user_id = $1),
       (SELECT avatar_url FROM feishu_user WHERE user_id = $1)
     ) AS avatar_url`,
    [userId],
  );
  const stored = res.rows[0]?.avatar_url ?? null;
  if (!stored) return new Response(null, { status: 404 });
  if (stored.startsWith("http")) return redirect(stored);

  try {
    const variant = await getAvatarVariant(stored, size);
    if (variant) {
      return new Response(new Uint8Array(variant.body), {
        headers: { "Content-Type": variant.contentType, "Cache-Control": IMMUTABLE },
      });
    }
  } catch (error) {
    // The provider avatar below is still a valid fallback, so an R2 failure
    // must not turn into 500. But credentials being present means this is a
    // real production degradation, not the expected credential-less local dev.
    if (isR2Configured()) {
      console.error(`[avatar-r2] lookup failed (user=${userId}); falling back to provider avatar:`, error);
    } else {
      console.warn("[avatar-r2] R2 not configured; using provider avatar");
    }
  }

  // R2 无对象或取失败：回落飞书同步的外链头像
  const fb = await getPool().query<{ avatar_url: string | null }>(
    `SELECT avatar_url FROM feishu_user WHERE user_id = $1`,
    [userId],
  );
  const fallbackUrl = fb.rows[0]?.avatar_url;
  if (fallbackUrl?.startsWith("http")) return redirect(fallbackUrl);

  return new Response(null, { status: 404 });
}
