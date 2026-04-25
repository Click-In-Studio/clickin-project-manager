import { type NextRequest } from "next/server";
import { updatePresence } from "@/lib/server-cache";

type PresenceBody = {
  clientId: string;
  userName: string;
  blockId: string | null;
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { clientId, userName, blockId } = (await req.json()) as PresenceBody;
  if (!clientId || !userName) return Response.json({ error: "missing fields" }, { status: 400 });
  updatePresence(id, clientId, userName, blockId);
  return Response.json({ ok: true });
}
