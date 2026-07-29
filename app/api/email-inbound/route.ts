import { timingSafeEqual } from "crypto";
import { type NextRequest } from "next/server";

export interface InboundEmailPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  inReplyTo: string | null;
  references: string | null;
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.EMAIL_INBOUND_SECRET;
  if (!secret) return false;
  const incoming = req.headers.get("Authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (incoming.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(incoming), Buffer.from(expected));
}

function isValidPayload(body: unknown): body is InboundEmailPayload {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return typeof b.from === "string" && b.from.length > 0
    && typeof b.to === "string" && b.to.length > 0
    && typeof b.messageId === "string";
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  if (!isValidPayload(body)) {
    return Response.json({ error: "missing required fields" }, { status: 400 });
  }

  // #131 will wire up the EmailPlatform adapter here.
  // Temporary: log receipt to verify the pipeline end-to-end (PII — remove once #131 lands).
  console.log("[email-inbound]", body.from, "→", body.to, "|", body.subject);

  return Response.json({ ok: true });
}
