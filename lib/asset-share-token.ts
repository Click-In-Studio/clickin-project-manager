import { createHmac } from "crypto";

type SharePayload = {
  aid: string;  // assetId
  pid: string;  // productionId
  exp: number;  // unix seconds
  dl: boolean;  // allowDownload
};

function secret(): string {
  return process.env.SESSION_SECRET ?? "dev-share-secret";
}

export function signShareToken(payload: SharePayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret()).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyShareToken(token: string): SharePayload | null {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret()).update(data).digest("base64url");
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as SharePayload;
    if (Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
