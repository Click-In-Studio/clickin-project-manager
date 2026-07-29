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
  return req.headers.get("Authorization") === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const payload = (await req.json()) as InboundEmailPayload;

  // #131 will wire up the EmailPlatform adapter here.
  // For now, log receipt so we can verify the pipeline end-to-end.
  console.log("[email-inbound]", payload.from, "→", payload.to, "|", payload.subject);

  return Response.json({ ok: true });
}
