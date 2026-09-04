import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getAvatarVariant, parseAvatarSize } from "@/lib/avatar-serve";
import { getPool } from "@/lib/pg";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return new Response(null, { status: 401 });

  const { id } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return new Response(null, { status: 403 });

  const res = await getPool().query<{ avatar_url: string | null }>(
    "SELECT avatar_url FROM production WHERE id = $1",
    [id],
  );
  const stored = res.rows[0]?.avatar_url ?? null;
  if (!stored) return new Response(null, { status: 404 });
  if (stored.startsWith("http")) {
    return new Response(null, {
      status: 302,
      headers: { Location: stored, "Cache-Control": "private, max-age=86400" },
    });
  }

  const size = parseAvatarSize(req.nextUrl.searchParams.get("s"));
  const variant = await getAvatarVariant(stored, size);
  if (!variant) return new Response(null, { status: 404 });

  return new Response(new Uint8Array(variant.body), {
    headers: {
      "Content-Type": variant.contentType,
      // key 每次上传换新 + URL 带 ?v=（lib/avatar-url.ts），换头像即换 URL，可放心 immutable
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
