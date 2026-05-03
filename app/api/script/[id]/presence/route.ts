import { type NextRequest } from "next/server";
import { updatePresence } from "@/lib/server-cache";
import { getActiveVersionId } from "@/lib/db";

type PresenceBody = {
  clientId: string;
  userName: string;
  blockId: string | null;
  versionId?: string;
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { clientId, userName, blockId, versionId: bodyVersionId } = (await req.json()) as PresenceBody;
  if (!clientId || !userName) return Response.json({ error: "missing fields" }, { status: 400 });
  const versionId = bodyVersionId ?? req.nextUrl.searchParams.get("v") ?? await getActiveVersionId(id) ?? '';
  updatePresence(id, versionId, clientId, userName, blockId);
  return Response.json({ ok: true });
}
