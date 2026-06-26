import { type NextRequest } from "next/server";
import { registerSSE, removePresence, presenceFrameFor } from "@/lib/server-cache";
import { getActiveVersionId, getVersion } from "@/lib/db";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const clientId = req.nextUrl.searchParams.get("cid") ?? Math.random().toString(36).slice(2);
  const connectionId = `${clientId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const versionId = req.nextUrl.searchParams.get("v") ?? await getActiveVersionId(id) ?? '';
  if (versionId) {
    const version = await getVersion(versionId);
    if (!version || version.productionId !== id) {
      return Response.json({ error: "版本不存在" }, { status: 404 });
    }
  }
  const enc = new TextEncoder();

  let cancelSSE: (() => boolean) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (frame: string) => {
        try { controller.enqueue(enc.encode(frame)); }
        catch { cancelSSE?.(); }
      };
      cancelSSE = registerSSE(id, versionId, connectionId, clientId, push);
      push(presenceFrameFor(id, versionId));
      push(`: connected\n\n`);
    },
    cancel() {
      const hasOtherConnections = cancelSSE?.() ?? false;
      if (!hasOtherConnections) {
        removePresence(id, versionId, clientId);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
