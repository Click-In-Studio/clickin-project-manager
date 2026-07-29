import { createHmac, timingSafeEqual } from "node:crypto";

const TTL_MS = 15 * 60 * 1000;

interface Payload {
  userId: string;
  email: string;
  exp: number;
}

function secret(): string {
  return process.env.SESSION_SECRET ?? "dev-secret-change-in-production";
}

export function signMagicToken(userId: string, email: string): string {
  const payload: Payload = { userId, email, exp: Date.now() + TTL_MS };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret()).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

export function verifyMagicToken(token: string): { userId: string; email: string } | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const b64 = token.slice(0, dot);
  const sigActual = token.slice(dot + 1);
  const sigExpected = createHmac("sha256", secret()).update(b64).digest("base64url");
  try {
    const a = Buffer.from(sigActual);
    const b = Buffer.from(sigExpected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(b64, "base64url").toString()) as Payload;
    if (data.exp < Date.now()) return null;
    return { userId: data.userId, email: data.email };
  } catch {
    return null;
  }
}
