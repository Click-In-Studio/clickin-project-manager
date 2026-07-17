import { createHmac } from "node:crypto";

export type CardTokenScope = "daily-call" | "weekly-call" | `report:${string}`;

export type CardTokenData = {
  openId: string;
  scope: CardTokenScope;
  exp: number;
};

function secret(): string {
  return process.env.SESSION_SECRET ?? "dev-secret-change-in-production";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createCardToken(openId: string, scope: CardTokenScope, exp: Date): string {
  const data: CardTokenData = { openId, scope, exp: exp.getTime() };
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyCardToken(token: string, expectedScope: CardTokenScope): CardTokenData | null {
  try {
    const dot = token.lastIndexOf(".");
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (sig !== sign(payload)) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as CardTokenData;
    if (data.exp < Date.now()) return null;
    if (data.scope !== expectedScope) return null;
    return data;
  } catch {
    return null;
  }
}
