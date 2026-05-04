import crypto from "crypto";

const accountId = process.env.R2_ACCOUNT_ID!;
const accessKeyId = process.env.R2_ACCESS_KEY_ID!;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY!;
export const r2Bucket = process.env.R2_BUCKET ?? "click-in";

const region = "auto";
const host = `${accountId}.r2.cloudflarestorage.com`;
const endpoint = `https://${host}`;

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}
function sha256hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function dateParts(): { dateStr: string; amzDate: string } {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const amzDate = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  return { dateStr, amzDate };
}

function getSigningKey(dateStr: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStr), region), "s3"), "aws4_request");
}

function sortedParams(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams(
    Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))
  );
}

export function assetR2Key(assetFileId: string, fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `assets/${assetFileId}/${safe}`;
}

export function thumbnailR2Key(assetFileId: string): string {
  return `thumbnails/${assetFileId}.webp`;
}

/** Presigned GET URL. */
export function presignedGet(key: string, expiresIn = 3600): string {
  const { dateStr, amzDate } = dateParts();
  const scope = `${dateStr}/${region}/s3/aws4_request`;
  const params = sortedParams({
    "X-Amz-Algorithm":    "AWS4-HMAC-SHA256",
    "X-Amz-Credential":   `${accessKeyId}/${scope}`,
    "X-Amz-Date":         amzDate,
    "X-Amz-Expires":      String(expiresIn),
    "X-Amz-SignedHeaders": "host",
  });
  const canonical = [
    "GET",
    `/${r2Bucket}/${key}`,
    params.toString(),
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const sig = crypto
    .createHmac("sha256", getSigningKey(dateStr))
    .update(`AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonical)}`)
    .digest("hex");
  params.set("X-Amz-Signature", sig);
  return `${endpoint}/${r2Bucket}/${key}?${params.toString()}`;
}

/** Presigned PUT URL. Client must send Content-Type: mimeType header. */
export function presignedPut(key: string, mimeType: string, expiresIn = 3600): { url: string; contentType: string } {
  const { dateStr, amzDate } = dateParts();
  const scope = `${dateStr}/${region}/s3/aws4_request`;
  const signedHeaders = "content-type;host";
  const params = sortedParams({
    "X-Amz-Algorithm":    "AWS4-HMAC-SHA256",
    "X-Amz-Credential":   `${accessKeyId}/${scope}`,
    "X-Amz-Date":         amzDate,
    "X-Amz-Expires":      String(expiresIn),
    "X-Amz-SignedHeaders": signedHeaders,
  });
  const canonical = [
    "PUT",
    `/${r2Bucket}/${key}`,
    params.toString(),
    `content-type:${mimeType}\nhost:${host}\n`,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const sig = crypto
    .createHmac("sha256", getSigningKey(dateStr))
    .update(`AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonical)}`)
    .digest("hex");
  params.set("X-Amz-Signature", sig);
  return { url: `${endpoint}/${r2Bucket}/${key}?${params.toString()}`, contentType: mimeType };
}

/** Upload a buffer to R2 from server-side. */
export async function putR2Object(key: string, body: Buffer, mimeType: string): Promise<void> {
  const { url, contentType } = presignedPut(key, mimeType);
  const res = await fetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body: new Uint8Array(body) });
  if (!res.ok) throw new Error(`R2 PUT failed: ${res.status} ${await res.text()}`);
}

/** Delete an object from R2. */
export async function deleteR2Object(key: string): Promise<void> {
  const { dateStr, amzDate } = dateParts();
  const scope = `${dateStr}/${region}/s3/aws4_request`;
  const signedHeaders = "host;x-amz-date";
  const canonical = [
    "DELETE",
    `/${r2Bucket}/${key}`,
    "",
    `host:${host}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    sha256hex(""),
  ].join("\n");
  const sig = crypto
    .createHmac("sha256", getSigningKey(dateStr))
    .update(`AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonical)}`)
    .digest("hex");
  await fetch(`${endpoint}/${r2Bucket}/${key}`, {
    method: "DELETE",
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
      "X-Amz-Date": amzDate,
    },
  });
}

/** Initiate a multipart upload. Returns the uploadId. */
export async function createMultipartUpload(key: string, mimeType: string): Promise<string> {
  const { dateStr, amzDate } = dateParts();
  const scope = `${dateStr}/${region}/s3/aws4_request`;
  const emptyHash = sha256hex("");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = [
    "POST",
    `/${r2Bucket}/${key}`,
    "uploads=",
    `host:${host}\nx-amz-content-sha256:${emptyHash}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    emptyHash,
  ].join("\n");
  const sig = crypto
    .createHmac("sha256", getSigningKey(dateStr))
    .update(`AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonical)}`)
    .digest("hex");

  const res = await fetch(`${endpoint}/${r2Bucket}/${key}?uploads`, {
    method: "POST",
    headers: {
      "Content-Type": mimeType,
      "X-Amz-Content-Sha256": emptyHash,
      "X-Amz-Date": amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    },
  });
  if (!res.ok) throw new Error(`CreateMultipartUpload failed: ${res.status} ${await res.text()}`);
  const xml = await res.text();
  const match = xml.match(/<UploadId>(.+?)<\/UploadId>/);
  if (!match) throw new Error(`No UploadId in response: ${xml}`);
  return match[1];
}

/** Generate a presigned URL for a single UploadPart request. Client PUTs the chunk directly. */
export function presignedUploadPart(key: string, uploadId: string, partNumber: number, expiresIn = 3600): string {
  const { dateStr, amzDate } = dateParts();
  const scope = `${dateStr}/${region}/s3/aws4_request`;
  const signedHeaders = "host";
  // Byte-order sort: uppercase X (88) < lowercase p (112) < lowercase u (117)
  const params = new URLSearchParams(
    [
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", `${accessKeyId}/${scope}`],
      ["X-Amz-Date", amzDate],
      ["X-Amz-Expires", String(expiresIn)],
      ["X-Amz-SignedHeaders", signedHeaders],
      ["partNumber", String(partNumber)],
      ["uploadId", uploadId],
    ].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
  const canonical = [
    "PUT",
    `/${r2Bucket}/${key}`,
    params.toString(),
    `host:${host}\n`,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const sig = crypto
    .createHmac("sha256", getSigningKey(dateStr))
    .update(`AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonical)}`)
    .digest("hex");
  params.set("X-Amz-Signature", sig);
  return `${endpoint}/${r2Bucket}/${key}?${params.toString()}`;
}

/** Complete a multipart upload. parts must include ETag from each UploadPart response. */
export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: { partNumber: number; eTag: string }[]
): Promise<void> {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const xmlBody = `<CompleteMultipartUpload>${sorted
    .map(p => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.eTag}</ETag></Part>`)
    .join("")}</CompleteMultipartUpload>`;

  const { dateStr, amzDate } = dateParts();
  const scope = `${dateStr}/${region}/s3/aws4_request`;
  const payloadHash = sha256hex(xmlBody);
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const queryStr = `uploadId=${encodeURIComponent(uploadId)}`;
  const canonical = [
    "POST",
    `/${r2Bucket}/${key}`,
    queryStr,
    `content-type:application/xml\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const sig = crypto
    .createHmac("sha256", getSigningKey(dateStr))
    .update(`AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonical)}`)
    .digest("hex");

  const res = await fetch(`${endpoint}/${r2Bucket}/${key}?${queryStr}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/xml",
      "X-Amz-Content-Sha256": payloadHash,
      "X-Amz-Date": amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    },
    body: xmlBody,
  });
  if (!res.ok) throw new Error(`CompleteMultipartUpload failed: ${res.status} ${await res.text()}`);
}

/** Fetch R2 object as Buffer (for proxying). */
export async function getR2Object(key: string): Promise<{ body: Buffer; contentType: string | null } | null> {
  const url = presignedGet(key);
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 GET failed: ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  return { body, contentType: res.headers.get("content-type") };
}
