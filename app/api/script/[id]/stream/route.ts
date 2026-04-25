import { type NextRequest } from "next/server";
import { registerSSE, removePresence, presenceFrame } from "@/lib/server-cache";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Client supplies its own stable clientId (generated in sessionStorage) so that
  // when the SSE connection drops we can remove the correct presence entry.
  const clientId = req.nextUrl.searchParams.get("cid") ?? Math.random().toString(36).slice(2);
  const enc = new TextEncoder();

  let cancelSSE: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (frame: string) => {
        try { controller.enqueue(enc.encode(frame)); }
        catch { cancelSSE?.(); }
      };
      cancelSSE = registerSSE(id, clientId, push);
      // Send current presence snapshot so the new client sees who's already online
      push(presenceFrame(id));
      push(`: connected\n\n`);
    },
    cancel() {
      cancelSSE?.();
      removePresence(id, clientId);
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
