/**
 * Sets CORS rules on an R2 bucket.
 * Usage: node scripts/set-r2-cors.mjs [bucket]
 * Reads R2_* env vars from .env.local if present.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Load .env.local
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../.env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

const accountId  = process.env.R2_ACCOUNT_ID;
const accessKey  = process.env.R2_ACCESS_KEY_ID;
const secretKey  = process.env.R2_SECRET_ACCESS_KEY;
const bucket     = process.argv[2] ?? process.env.R2_BUCKET;

if (!accountId || !accessKey || !secretKey || !bucket) {
  console.error("Missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or bucket");
  process.exit(1);
}

const host     = `${accountId}.r2.cloudflarestorage.com`;
const endpoint = `https://${host}`;
const region   = "auto";

// CORS config: allow both production origin and local dev
const corsXml = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>https://www.clickinmusical.com</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
  <CORSRule>
    <AllowedOrigin>http://localhost:3000</AllowedOrigin>
    <AllowedOrigin>http://localhost:3001</AllowedOrigin>
    <AllowedOrigin>http://127.0.0.1:3000</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>`;

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}
function sha256hex(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

const now = new Date();
const dateStr  = now.toISOString().slice(0, 10).replace(/-/g, "");
const amzDate  = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
const scope    = `${dateStr}/${region}/s3/aws4_request`;

const payloadHash = sha256hex(corsXml);
const signedHeaders = "content-md5;content-type;host;x-amz-content-sha256;x-amz-date";

// Content-MD5 (required by S3 for PutBucketCors)
const md5 = crypto.createHash("md5").update(corsXml).digest("base64");

const canonicalRequest = [
  "PUT",
  `/${bucket}/?cors`,
  "",
  `content-md5:${md5}`,
  `content-type:application/xml`,
  `host:${host}`,
  `x-amz-content-sha256:${payloadHash}`,
  `x-amz-date:${amzDate}`,
  "",
  signedHeaders,
  payloadHash,
].join("\n");

const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`;

const signingKey = hmac(
  hmac(hmac(hmac(`AWS4${secretKey}`, dateStr), region), "s3"),
  "aws4_request"
);
const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

const res = await fetch(`${endpoint}/${bucket}/?cors`, {
  method: "PUT",
  headers: {
    "Content-Type": "application/xml",
    "Content-MD5": md5,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  },
  body: corsXml,
});

if (res.ok) {
  console.log(`✓ CORS set on bucket: ${bucket}`);
  console.log("  Allowed origins:");
  console.log("    https://www.clickinmusical.com");
  console.log("    http://localhost:3000");
  console.log("    http://localhost:3001");
  console.log("    http://127.0.0.1:3000");
  console.log("  Allowed methods: GET, PUT");
} else {
  const body = await res.text();
  console.error(`✗ Failed (${res.status}):`, body);
  process.exit(1);
}
