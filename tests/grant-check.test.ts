import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { hasGrant, listGrantedResourceIds, isReservedSub } from "@/lib/grant-check";

// 权限REST化核心 checker：通配 × 保留段 × 过期 × 非线性。
// grant 行 = (production根/type/<id>/sub @ verb)，命中全部精确、无等级比较。

let prodId: string;
let userId: string;

async function insertGrant(
  resourceId: string,
  resourceSub: string,
  verb: string,
  opts: { expiresAt?: string; revoked?: boolean } = {},
): Promise<void> {
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub,
        permission_level, grant_source, confirmed_by, is_revoked, expires_at)
     VALUES ($1, $2, 'cue_list', $3, $4, $5, 'direct', $2, $6, $7)`,
    [prodId, userId, resourceId, resourceSub, verb, opts.revoked ?? false, opts.expiresAt ?? null],
  );
}

beforeAll(async () => {
  userId = (await upsertFeishuUser(`test-open-${shortId()}`, `授权甲${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(userId));
  // 动词词汇行（与 db/add-rest-verbs.sql 同构，幂等）
  await getPool().query(
    `INSERT INTO resource_permission_level (resource_type, permission_level, sort_order)
     VALUES ('cue_list', 'create', 0), ('cue_list', 'delete', 0)
     ON CONFLICT DO NOTHING`,
  );
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("精确命中与非线性", () => {
  it("exact row hits its own (node, verb) only", async () => {
    const id = shortId();
    await insertGrant(id, "meta", "view");
    expect(await hasGrant(userId, prodId, "cue_list", id, "meta", "view")).toBe(true);
    // 非线性：view 行不给 edit，edit 行也不会给 view
    expect(await hasGrant(userId, prodId, "cue_list", id, "meta", "edit")).toBe(false);
    // 不同 sub 不命中
    expect(await hasGrant(userId, prodId, "cue_list", id, "cues", "view")).toBe(false);
    // 不同实例不命中
    expect(await hasGrant(userId, prodId, "cue_list", shortId(), "meta", "view")).toBe(false);
  });
});

describe("通配语义", () => {
  it("resource_id='*' matches any instance", async () => {
    await insertGrant("*", "meta", "delete");
    expect(await hasGrant(userId, prodId, "cue_list", shortId(), "meta", "delete")).toBe(true);
  });

  it("resource_sub='*' matches subtree but NOT reserved subs", async () => {
    const id = shortId();
    await insertGrant(id, "*", "edit");
    expect(await hasGrant(userId, prodId, "cue_list", id, "cues", "edit")).toBe(true);
    expect(await hasGrant(userId, prodId, "cue_list", id, "meta/name", "edit")).toBe(true);
    // 保留段必须显式：整树通配不含 grants/publication 及其子路径
    expect(await hasGrant(userId, prodId, "cue_list", id, "grants", "edit")).toBe(false);
    expect(await hasGrant(userId, prodId, "cue_list", id, "publication", "edit")).toBe(false);
    expect(await hasGrant(userId, prodId, "cue_list", id, "grants/sub", "edit")).toBe(false);
  });

  it("explicit reserved-sub rows work, including id-wildcard admin rows", async () => {
    const id = shortId();
    await insertGrant(id, "grants", "edit");
    expect(await hasGrant(userId, prodId, "cue_list", id, "grants", "edit")).toBe(true);
    // 管理员通配：id='*' + 显式 grants 段
    await insertGrant("*", "grants", "delete");
    expect(await hasGrant(userId, prodId, "cue_list", shortId(), "grants", "delete")).toBe(true);
  });
});

describe("时效", () => {
  it("expired and revoked rows never hit", async () => {
    const id = shortId();
    await insertGrant(id, "meta", "create", { expiresAt: "2000-01-01T00:00:00Z" });
    expect(await hasGrant(userId, prodId, "cue_list", id, "meta", "create")).toBe(false);
    const id2 = shortId();
    await insertGrant(id2, "meta", "create", { revoked: true });
    expect(await hasGrant(userId, prodId, "cue_list", id2, "meta", "create")).toBe(false);
  });

  it("future expiry still hits", async () => {
    const id = shortId();
    await insertGrant(id, "meta", "create", { expiresAt: "2099-01-01T00:00:00Z" });
    expect(await hasGrant(userId, prodId, "cue_list", id, "meta", "create")).toBe(true);
  });
});

describe("listGrantedResourceIds（目录行入口）", () => {
  it("returns granted instance ids; wildcard row short-circuits", async () => {
    const other = (await upsertFeishuUser(`test-open-${shortId()}`, `授权乙${shortId()}`, null, false)).userId;
    const a = shortId();
    const b = shortId();
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'scene', $3, 'meta', 'view', 'direct', $2),
              ($1, $2, 'scene', $4, 'meta', 'view', 'direct', $2)`,
      [prodId, other, a, b],
    );
    const res = await listGrantedResourceIds(other, prodId, "scene", "meta", "view");
    expect(res.wildcard).toBe(false);
    expect(res.ids.sort()).toEqual([a, b].sort());

    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'scene', '*', 'meta', 'view', 'direct', $2)`,
      [prodId, other, ],
    );
    expect((await listGrantedResourceIds(other, prodId, "scene", "meta", "view")).wildcard).toBe(true);
  });
});

describe("isReservedSub", () => {
  it("matches reserved segs and their sub-paths only", () => {
    expect(isReservedSub("grants")).toBe(true);
    expect(isReservedSub("publication")).toBe(true);
    expect(isReservedSub("grants/x")).toBe(true);
    expect(isReservedSub("grantsx")).toBe(false);
    expect(isReservedSub("meta")).toBe(false);
    expect(isReservedSub("*")).toBe(false);
  });
});
