/**
 * lib/avatar-serve 分支覆盖（R2 层 mock，sharp 走真实现）：
 * - 变体命中：直接返回，不取原图
 * - 变体缺失：懒生成（尺寸/格式正确）+ 写回 R2（存量头像自愈路径）
 * - 原图缺失：null（调用方走外链兜底）
 * - 原图损坏：sharp 失败降级返回原图，不抛
 * - deleteAvatarObjects：三个 key 全删、外链/null 不删、删失败不抛
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";

vi.mock("@/lib/r2", () => ({
  getR2Object: vi.fn(),
  putR2Object: vi.fn().mockResolvedValue(undefined),
  deleteR2Object: vi.fn().mockResolvedValue(undefined),
}));

import { getR2Object, putR2Object, deleteR2Object } from "@/lib/r2";
import { getAvatarVariant, parseAvatarSize, deleteAvatarObjects } from "@/lib/avatar-serve";

const mockGet = vi.mocked(getR2Object);
const mockPut = vi.mocked(putR2Object);
const mockDelete = vi.mocked(deleteR2Object);

function makePng(width = 300, height = 200): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .png().toBuffer();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPut.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue(undefined);
});

describe("parseAvatarSize", () => {
  it("只认 512，其余（128/缺省/垃圾值）一律回落 128", () => {
    expect(parseAvatarSize("512")).toBe(512);
    expect(parseAvatarSize("128")).toBe(128);
    expect(parseAvatarSize(null)).toBe(128);
    expect(parseAvatarSize("9999")).toBe(128);
  });
});

describe("getAvatarVariant", () => {
  it("变体已存在：直接返回 webp，不取原图", async () => {
    const webp = await sharp(await makePng()).webp().toBuffer();
    mockGet.mockResolvedValueOnce({ body: webp, contentType: "image/webp" });

    const out = await getAvatarVariant("avatars/u1/avatar-a", 128);
    expect(out?.contentType).toBe("image/webp");
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith("avatars/u1/avatar-a@128.webp");
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("变体缺失：拉原图懒生成正确尺寸的 webp 并写回（存量自愈）", async () => {
    mockGet.mockResolvedValueOnce(null); // 变体 miss
    mockGet.mockResolvedValueOnce({ body: await makePng(300, 200), contentType: "image/png" });

    const out = await getAvatarVariant("avatars/u1/avatar-a", 128);
    expect(out?.contentType).toBe("image/webp");
    const meta = await sharp(out!.body).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(128);
    expect(meta.height).toBe(128); // fit: cover 裁方
    expect(mockPut).toHaveBeenCalledWith("avatars/u1/avatar-a@128.webp", expect.any(Buffer), "image/webp");
  });

  it("原图缺失：返回 null（调用方走外链兜底）", async () => {
    mockGet.mockResolvedValue(null);
    expect(await getAvatarVariant("avatars/u1/gone", 128)).toBeNull();
  });

  it("原图损坏：sharp 失败降级返回原图，不抛", async () => {
    mockGet.mockResolvedValueOnce(null);
    mockGet.mockResolvedValueOnce({ body: Buffer.from("not an image"), contentType: "image/png" });

    const out = await getAvatarVariant("avatars/u1/corrupt", 128);
    expect(out?.body.toString()).toBe("not an image");
    expect(out?.contentType).toBe("image/png");
  });

  it("变体写回失败不影响本次响应", async () => {
    mockGet.mockResolvedValueOnce(null);
    mockGet.mockResolvedValueOnce({ body: await makePng(), contentType: "image/png" });
    mockPut.mockRejectedValueOnce(new Error("r2 down"));

    const out = await getAvatarVariant("avatars/u1/avatar-a", 512);
    expect(out?.contentType).toBe("image/webp");
  });
});

describe("deleteAvatarObjects", () => {
  it("R2 key：原图 + 两档变体全删", async () => {
    await deleteAvatarObjects("avatars/u1/avatar-old");
    const keys = mockDelete.mock.calls.map(c => c[0]).sort();
    expect(keys).toEqual([
      "avatars/u1/avatar-old",
      "avatars/u1/avatar-old@128.webp",
      "avatars/u1/avatar-old@512.webp",
    ]);
  });

  it("外链 / null：不发起删除", async () => {
    await deleteAvatarObjects("https://cdn.example.com/a.jpg");
    await deleteAvatarObjects(null);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("删失败被吞掉，不向外抛（调用方 void 它是安全的）", async () => {
    mockDelete.mockRejectedValue(new Error("boom"));
    await expect(deleteAvatarObjects("avatars/u1/avatar-old")).resolves.toBeUndefined();
  });
});
