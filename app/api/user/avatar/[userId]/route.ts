import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getR2Stream } from "@/lib/r2";
import { getPool } from "@/lib/pg";

type Ctx = { params: Promise<{ userId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return new Response(null, { status: 401 });

  const { userId } = await ctx.params;
  const r2Key = `avatars/${userId}/avatar`;
  const stream = await getR2Stream(r2Key);
  if (stream) {
    const contentType = stream.headers.get("content-type") ?? "image/jpeg";
    return new Response(stream.body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  }

  // Fallback: redirect to the profile avatar URL (feishu sync value as last resort)
  const res = await getPool().query<{ avatar_url: string | null }>(
    `SELECT COALESCE(
       (SELECT avatar_url FROM user_profile WHERE user_id = $1),
       (SELECT avatar_url FROM feishu_user WHERE user_id = $1)
     ) AS avatar_url`,
    [userId],
  );
  const fallbackUrl = res.rows[0]?.avatar_url;
  if (fallbackUrl) return Response.redirect(fallbackUrl, 302);

  return new Response(null, { status: 404 });
}
