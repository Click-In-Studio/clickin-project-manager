/**
 * 头像上传审计账本生命周期（真 DB，R2 层 mock）：
 * presign 记账 → 孤儿查询可见 → 提交平账消失 / 清理平账消失 / 删不净留账。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

vi.mock("@/lib/r2", () => ({
  getR2Object: vi.fn(),
  putR2Object: vi.fn().mockResolvedValue(undefined),
  deleteR2Object: vi.fn().mockResolvedValue(undefined),
}));

import { deleteR2Object } from "@/lib/r2";
import { recordAvatarUpload, markAvatarCommitted, cleanupAvatarObjects } from "@/lib/avatar-db";
import { getPool } from "@/lib/pg";
import { TEST_USER } from "./helpers";
import { shortId } from "./factories";

const mockDelete = vi.mocked(deleteR2Object);
// 本测试专属 key 前缀，afterAll 一把清
const prefix = `avatars/test-${shortId()}`;

function key(suffix: string): string {
  return `${prefix}/${suffix}`;
}

async function orphanKeys(): Promise<string[]> {
  const res = await getPool().query<{ r2_key: string }>(
    `SELECT r2_key FROM avatar_upload_audit
     WHERE committed_at IS NULL AND deleted_at IS NULL AND r2_key LIKE $1`,
    [`${prefix}/%`],
  );
  return res.rows.map(r => r.r2_key);
}

beforeEach(() => {
  mockDelete.mockReset();
  mockDelete.mockResolvedValue(undefined);
});

afterAll(async () => {
  await getPool().query(`DELETE FROM avatar_upload_audit WHERE r2_key LIKE $1`, [`${prefix}/%`]);
});

describe("avatar_upload_audit 生命周期", () => {
  it("presign 记账后是孤儿；提交平账后不再是", async () => {
    const k = key("avatar-a");
    await recordAvatarUpload("user", TEST_USER, k, TEST_USER);
    expect(await orphanKeys()).toContain(k);

    await markAvatarCommitted(k);
    expect(await orphanKeys()).not.toContain(k);
  });

  it("清理成功平账 deleted_at；孤儿查询不再可见", async () => {
    const k = key("avatar-b");
    await recordAvatarUpload("production", "prod-x", k, TEST_USER);
    await cleanupAvatarObjects(k);

    expect(await orphanKeys()).not.toContain(k);
    const res = await getPool().query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM avatar_upload_audit WHERE r2_key = $1`, [k],
    );
    expect(res.rows[0]?.deleted_at).not.toBeNull();
  });

  it("删不净不平账：留在账上继续算孤儿", async () => {
    const k = key("avatar-c");
    await recordAvatarUpload("user", TEST_USER, k, TEST_USER);
    mockDelete.mockRejectedValue(new Error("r2 down"));

    await cleanupAvatarObjects(k); // 不抛
    expect(await orphanKeys()).toContain(k);
  });

  it("markAvatarCommitted 对外链 / null 直接返回，不碰账本", async () => {
    await markAvatarCommitted("https://cdn.example.com/a.jpg");
    await markAvatarCommitted(null);
    // 无断言目标行——只要不抛即可（外链不进账本）
  });
});
