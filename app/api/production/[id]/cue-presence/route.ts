import { type NextRequest } from "next/server";
import { updateCuePresence } from "@/lib/server-cache";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { clientId, userName, listId, cueId } = await req.json() as {
    clientId: string; userName: string; listId: string | null; cueId: string | null;
  };
  if (!clientId || !userName) return Response.json({ error: "missing fields" }, { status: 400 });
  updateCuePresence(id, clientId, userName, listId ?? null, cueId ?? null);
  return Response.json({ ok: true });
}
