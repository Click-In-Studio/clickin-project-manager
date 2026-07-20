import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/pg";
import { resolveNotificationTarget, batchResolveNotificationTargets } from "@/lib/platform/notification-router";

// ── Test data helpers ─────────────────────────────────────────────────────────

async function createTestUser(): Promise<string> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    `INSERT INTO app_user DEFAULT VALUES RETURNING id`,
  );
  return res.rows[0].id;
}

async function createIdentity(
  userId: string,
  platformId: string,
  platformUserId: string,
  isLoginMethod = false,
): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_login_method)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, platformId, platformUserId, isLoginMethod],
  );
  return res.rows[0].id;
}

async function setPreference(
  userId: string,
  scopeType: string,
  scopeId: string,
  identityId: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO notification_preference (user_id, scope_type, scope_id, platform_identity_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, scope_type, scope_id) DO UPDATE SET platform_identity_id = EXCLUDED.platform_identity_id`,
    [userId, scopeType, scopeId, identityId],
  );
}

async function cleanup(userIds: string[]): Promise<void> {
  if (!userIds.length) return;
  await getPool().query(`DELETE FROM app_user WHERE id = ANY($1)`, [userIds]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("notification router", () => {
  const userIds: string[] = [];
  let userId1: string;
  let userId2: string;
  let userId3: string;
  const prodId = `test-prod-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    [userId1, userId2, userId3] = await Promise.all([
      createTestUser(),
      createTestUser(),
      createTestUser(),
    ]);
    userIds.push(userId1, userId2, userId3);
  });

  afterAll(async () => {
    await cleanup(userIds);
  });

  it("returns null for user with no platform identity", async () => {
    const result = await resolveNotificationTarget(userId1);
    expect(result).toBeNull();
  });

  it("falls back to first identity when no preference set", async () => {
    await createIdentity(userId1, "feishu", `feishu-open-id-${userId1}`, true);
    const result = await resolveNotificationTarget(userId1);
    expect(result).not.toBeNull();
    expect(result?.platformId).toBe("feishu");
    expect(result?.platformUserId).toBe(`feishu-open-id-${userId1}`);
  });

  it("respects global notification_preference over first identity", async () => {
    // userId2: has a feishu identity AND a second identity, global pref points to second
    const feishuId = await createIdentity(userId2, "feishu", `feishu-${userId2}`, true);
    const emailId = await createIdentity(userId2, "email", `email-${userId2}@test.com`);
    await setPreference(userId2, "global", "", emailId);

    const result = await resolveNotificationTarget(userId2);
    expect(result?.platformId).toBe("email");
    expect(result?.platformUserId).toBe(`email-${userId2}@test.com`);
    void feishuId;
  });

  it("respects production-scoped preference over global", async () => {
    // userId3: global → email, production → feishu
    const feishuId = await createIdentity(userId3, "feishu", `feishu-${userId3}`, true);
    const emailId = await createIdentity(userId3, "email", `email-${userId3}@test.com`);
    await setPreference(userId3, "global", "", emailId);
    await setPreference(userId3, "production", prodId, feishuId);

    const withProd = await resolveNotificationTarget(userId3, prodId);
    expect(withProd?.platformId).toBe("feishu");

    const withoutProd = await resolveNotificationTarget(userId3);
    expect(withoutProd?.platformId).toBe("email");
  });

  it("batch resolve returns a map with all reachable users", async () => {
    const ghostId = await createTestUser();
    userIds.push(ghostId);

    const targets = await batchResolveNotificationTargets([userId1, userId2, userId3, ghostId]);
    expect(targets.has(userId1)).toBe(true);
    expect(targets.has(userId2)).toBe(true);
    expect(targets.has(userId3)).toBe(true);
    expect(targets.has(ghostId)).toBe(false);
  });

  it("unknown platform_id is silently skipped", async () => {
    const userId = await createTestUser();
    userIds.push(userId);
    await createIdentity(userId, "mars", `mars-${userId}`);

    const result = await resolveNotificationTarget(userId);
    expect(result).toBeNull();
  });
});
