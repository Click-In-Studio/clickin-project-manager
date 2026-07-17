import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { uploadPartRelay } from "@/lib/r2";

// Max part size the relay will accept (matches client PART_SIZE + headroom)
const MAX_RELAY_PART_BYTES = 60 * 1024 * 1024; // 60 MB

// In-process slot counter — limits concurrent relay uploads so the server
// doesn't buffer multiple 50 MB chunks simultaneously.
// Works correctly for single-process pm2 deployments.
let relaySlotsInUse = 0;
const MAX_RELAY_SLOTS = 2;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;

  // ── Auth ───────────────────────────────────────────────────────────────────
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { memberRoles, overrides } = await getProductionMemberContext(
    session.openId, session.isAdmin, id,
  );
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  // ── Params ─────────────────────────────────────────────────────────────────
  const sp = new URL(req.url).searchParams;
  const r2Key     = sp.get("r2Key");
  const uploadId  = sp.get("uploadId");
  const partNumber = parseInt(sp.get("partNumber") ?? "0", 10);

  if (!r2Key || !uploadId || !partNumber || partNumber < 1 || partNumber > 10_000)
    return Response.json({ error: "缺少或非法参数 (r2Key / uploadId / partNumber)" }, { status: 400 });

  // ── Size guard (before reading body) ──────────────────────────────────────
  const clHeader = req.headers.get("content-length");
  const contentLength = clHeader ? parseInt(clHeader, 10) : NaN;
  if (!isNaN(contentLength) && contentLength > MAX_RELAY_PART_BYTES)
    return Response.json(
      { error: `分片超过中继大小限制 (max ${MAX_RELAY_PART_BYTES / 1024 / 1024} MB)` },
      { status: 413 },
    );

  // ── Concurrency guard ──────────────────────────────────────────────────────
  if (relaySlotsInUse >= MAX_RELAY_SLOTS)
    return Response.json({ error: "服务器中继繁忙，请稍后重试" }, { status: 503 });

  relaySlotsInUse++;
  try {
    if (!req.body)
      return Response.json({ error: "无请求体" }, { status: 400 });

    // Read body with a hard size cap — reject oversized streams even without
    // a Content-Length header (e.g. chunked encoding).
    const buf = await readBodyCapped(req.body, MAX_RELAY_PART_BYTES);
    if (buf === null)
      return Response.json(
        { error: `分片超过中继大小限制 (max ${MAX_RELAY_PART_BYTES / 1024 / 1024} MB)` },
        { status: 413 },
      );

    const eTag = await uploadPartRelay(r2Key, uploadId, partNumber, buf);
    return Response.json({ eTag });

  } finally {
    relaySlotsInUse--;
  }
}

/**
 * Reads a ReadableStream into an ArrayBuffer, aborting if the total size
 * exceeds `maxBytes`. Returns null if limit is exceeded.
 */
async function readBodyCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) return null;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // Merge into a single ArrayBuffer
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
