import { createHmac, timingSafeEqual } from "node:crypto";

const TTL_MS = 15 * 60 * 1000;

function secret(): string {
  return process.env.SESSION_SECRET ?? "dev-secret-change-in-production";
}

function sign(payload: object): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret()).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

function verify<T extends object>(token: string): T | null {
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
    const data = JSON.parse(Buffer.from(b64, "base64url").toString()) as T & { exp?: number };
    if (data.exp !== undefined && data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

// ── Magic link (login) ────────────────────────────────────────────────────────

export function signMagicToken(userId: string, email: string): string {
  return sign({ intent: "login", userId, email, exp: Date.now() + TTL_MS });
}

export function verifyMagicToken(token: string): { userId: string; email: string } | null {
  const data = verify<{ intent: string; userId: string; email: string }>(token);
  if (!data || data.intent !== "login") return null;
  return { userId: data.userId, email: data.email };
}

// ── Binding token (bind identity to existing account) ────────────────────────

export function signBindingToken(sourceUserId: string, email: string): string {
  return sign({ intent: "bind", sourceUserId, email, exp: Date.now() + TTL_MS });
}

export function verifyBindingToken(token: string): { sourceUserId: string; email: string } | null {
  const data = verify<{ intent: string; sourceUserId: string; email: string }>(token);
  if (!data || data.intent !== "bind") return null;
  return { sourceUserId: data.sourceUserId, email: data.email };
}

// ── Merge token (confirm merging two accounts) ────────────────────────────────

export function signMergeToken(keepUserId: string, deleteUserId: string): string {
  return sign({ intent: "merge", keepUserId, deleteUserId, exp: Date.now() + TTL_MS });
}

export function verifyMergeToken(token: string): { keepUserId: string; deleteUserId: string } | null {
  const data = verify<{ intent: string; keepUserId: string; deleteUserId: string }>(token);
  if (!data || data.intent !== "merge") return null;
  return { keepUserId: data.keepUserId, deleteUserId: data.deleteUserId };
}
