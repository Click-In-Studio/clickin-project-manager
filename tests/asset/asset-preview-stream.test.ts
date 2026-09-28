import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { createAsset } from "@/lib/asset/db";
import { getPool } from "@/lib/pg";
import { GET } from "@/app/api/production/[id]/assets/[assetId]/stream/route";
import { cleanupProduction, makeProduction } from "../_support/factories";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("@/lib/r2", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/r2")>(),
  getR2Stream: streamMock,
}));

let prodId: string;
let ownerId: string;
let viewerId: string;
let fileOnlyId: string;
let outsiderId: string;
let assetId: string;

function request(userId: string | null, range?: string) {
  const headers = new Headers();
  if (userId) {
    headers.set("Cookie", `${SESSION_COOKIE}=${createSession({
      userId, name: "测试", avatarUrl: null, isAdmin: false,
    })}`);
  }
  if (range) headers.set("Range", range);
  return new NextRequest("http://localhost/api/asset-stream", { headers });
}

const ctx = () => ({ params: Promise.resolve({ id: prodId, assetId }) });

beforeAll(async () => {
  [ownerId, viewerId, fileOnlyId, outsiderId] = (await getPool().query<{ id: string }>(
    "INSERT INTO app_user (id) SELECT gen_random_uuid() FROM generate_series(1,4) RETURNING id",
  )).rows.map(row => row.id);
  ({ prodId } = await makeProduction(ownerId));
  for (const userId of [viewerId, fileOnlyId]) {
    await getPool().query(
      "INSERT INTO production_member (production_id,user_id,roles) VALUES ($1,$2,'{}')",
      [prodId, userId],
    );
  }
  assetId = (await createAsset({
    productionId: prodId,
    uploaderUserId: ownerId,
    assetType: "reference",
    fileName: "预览.pdf",
    mimeType: "application/pdf",
    storageType: "r2",
    r2Key: "tests/asset-preview.pdf",
  })).asset.id;
  await getPool().query(
    `INSERT INTO production_member_grant
      (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source)
     VALUES ($1,$2,'asset',$4,'*','view','direct'),
            ($1,$3,'asset',$4,'file','view','direct')`,
    [prodId, viewerId, fileOnlyId, assetId],
  );
});

beforeEach(() => {
  streamMock.mockReset().mockResolvedValue(new Response("preview-bytes", {
    status: 206,
    headers: {
      "content-type": "application/pdf",
      "content-range": "bytes 0-12/13",
      "content-length": "13",
    },
  }));
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query(
    "DELETE FROM app_user WHERE id = ANY($1)", [[ownerId, viewerId, fileOnlyId, outsiderId]],
  ).catch(() => {});
});

describe("资产站内预览流", () => {
  it("未登录 401、非成员 403、只持 file@view 单枚键仍 403", async () => {
    expect((await GET(request(null), ctx())).status).toBe(401);
    expect((await GET(request(outsiderId), ctx())).status).toBe(403);
    expect((await GET(request(fileOnlyId), ctx())).status).toBe(403);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("正文读者可经鉴权流预览，Range 原样传递且不暴露 R2 地址", async () => {
    const response = await GET(request(viewerId, "bytes=0-12"), ctx());
    expect(response.status).toBe(206);
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-range")).toBe("bytes 0-12/13");
    expect(await response.text()).toBe("preview-bytes");
    expect(streamMock).toHaveBeenCalledWith("tests/asset-preview.pdf", "bytes=0-12");
  });
});
