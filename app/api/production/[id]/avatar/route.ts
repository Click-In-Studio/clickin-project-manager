import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getR2Stream } from "@/lib/r2";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return new Response(null, { status: 401 });

  const { id } = await ctx.params;
  const r2Key = `avatars/production/${id}/avatar`;
  const stream = await getR2Stream(r2Key);
  if (!stream) return new Response(null, { status: 404 });

  const contentType = stream.headers.get("content-type") ?? "image/jpeg";
  return new Response(stream.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
