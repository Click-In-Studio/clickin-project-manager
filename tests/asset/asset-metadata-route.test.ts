// #446 防倒退：metadata 路由的 Cache-Control 契约。此前 max-age=3600 贴在不带
// parserVersion 的 URL 上，热修后用户端着乱码 JSON 一小时（线上事故）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { createAsset } from "@/lib/asset/db";
import { setAssetFileMetadata, type MetadataEnvelope } from "@/lib/asset/metadata";
import { BROKER_VERSION } from "@/lib/asset/metadata-broker";
import { zipParser } from "@/lib/asset/metadata-parsers";
import { GET as metadataGET } from "@/app/api/production/[id]/assets/[assetId]/metadata/route";
import { makeProduction, cleanupProduction } from "../_support/factories";

let prodId: string;
let uploader: string;
let assetId: string;
let fileId: string;

const cookieFor = (userId: string) =>
  `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;

const req = (url: string, userId: string) =>
  new NextRequest(`http://localhost${url}`, { headers: { Cookie: cookieFor(userId) } });

const ctx = () => ({ params: Promise.resolve({ id: prodId, assetId }) });

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  const u = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  uploader = u.rows[0].id;
  await getPool().query(
    `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')`,
    [prodId, uploader],
  );
  const created = await createAsset({
    productionId: prodId, uploaderUserId: uploader, assetType: "reference",
    fileName: "交付.zip", mimeType: "application/zip", storageType: "r2",
    r2Key: "assets/test/交付.zip", fileSize: 1000,
  });
  assetId = created.asset.id;
  fileId = created.file.id;
  // 预置新鲜 zip 信封（版本=当前 ⇒ 路由不触发重算、不碰 R2）；
  // entries 里的条目故意缺 offset/method → entry 请求走确定性 reason 路径
  const env: MetadataEnvelope = {
    status: "ok", brokerVersion: BROKER_VERSION, parserKey: "application/zip",
    parserVersion: zipParser.version, detectedType: "application/zip",
    extractedAt: new Date().toISOString(), sidecarKey: null, error: null,
    data: { entryCount: 1, entries: [{ path: "a.wav" }] },
  };
  await setAssetFileMetadata(fileId, env);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("metadata 路由 Cache-Control 契约", () => {
  it("清单响应 private, no-cache（URL 不带版本，禁长缓存）", async () => {
    const res = await metadataGET(req(`/api/production/${prodId}/assets/${assetId}/metadata`, uploader), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    const j = await res.json();
    expect(j.metadata?.parserKey).toBe("application/zip");
  });

  it("entry 响应 private, max-age=300（有真实计算成本，允许有界陈旧）", async () => {
    const res = await metadataGET(
      req(`/api/production/${prodId}/assets/${assetId}/metadata?entry=${encodeURIComponent("a.wav")}`, uploader),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
    const j = await res.json();
    expect(j.reason).toBeTruthy(); // 缺 offset/method 的确定性拒绝路径
  });
});
