import { createHmac, timingSafeEqual } from "node:crypto";

export type MultipartAbortScope = {
  productionId: string;
  userId: string;
  r2Key: string;
  uploadId: string;
};

type MultipartAbortToken = MultipartAbortScope & { expiresAt: number };

function secret(): string {
  return process.env.SESSION_SECRET ?? "dev-secret-change-in-production";
}

function signature(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createMultipartAbortToken(scope: MultipartAbortScope): string {
  const payload = Buffer.from(JSON.stringify({
    ...scope,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
  } satisfies MultipartAbortToken)).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

export function verifyMultipartAbortToken(token: string, expected: MultipartAbortScope): boolean {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const actual = Buffer.from(token.slice(dot + 1));
  const signed = Buffer.from(signature(payload));
  if (actual.length !== signed.length || !timingSafeEqual(actual, signed)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as MultipartAbortToken;
    return data.expiresAt >= Date.now()
      && data.productionId === expected.productionId
      && data.userId === expected.userId
      && data.r2Key === expected.r2Key
      && data.uploadId === expected.uploadId;
  } catch {
    return false;
  }
}
