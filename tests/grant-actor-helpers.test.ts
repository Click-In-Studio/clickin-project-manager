import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { hasEventDomainView, hasEventContentEdit } from "@/lib/event-permissions";
import { getPool } from "@/lib/pg";

// review 采纳配套：新导出 helper 的专项测试。
// toActor 的价值在于杜绝布尔字段错位——测试钉死映射方向。

let prodId: string;
let userId: string;

beforeAll(async () => {
  userId = (await upsertFeishuUser(`test-open-${shortId()}`, `门甲${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(userId));
  await addProductionMember(prodId, userId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("toActor", () => {
  it("maps fields without swapping", () => {
    const a = toActor({ userId: "u1" }, { isAdmin: true, isOwner: false });
    expect(a).toEqual({ userId: "u1", isAdmin: true, isOwner: false });
    const b = toActor({ userId: "u2" }, { isAdmin: false, isOwner: true });
    expect(b).toEqual({ userId: "u2", isAdmin: false, isOwner: true });
  });
});

describe("hasEventDomainView", () => {
  it("meta 或 details 任一行即可过域门；无行不过；admin 旁路", async () => {
    const actor = { userId, isAdmin: false, isOwner: false };
    expect(await hasEventDomainView(actor, prodId)).toBe(false);
    await getPool().query(
      `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'event', '*', 'meta', 'view', 'self_confirmed', $2)`,
      [prodId, userId],
    );
    expect(await hasEventDomainView(actor, prodId)).toBe(true);
    expect(await hasEventDomainView({ userId: "00000000-0000-0000-0000-0000000000ff", isAdmin: true, isOwner: false }, prodId)).toBe(true);
  });
});

describe("hasEventContentEdit（状态感知）", () => {
  it("draft 看 details@edit；published 看 publication@edit", async () => {
    const actor = { userId, isAdmin: false, isOwner: false };
    const evId = shortId();
    await getPool().query(
      `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'event', $3, 'details', 'edit', 'direct', $2)`,
      [prodId, userId, evId],
    );
    expect(await hasEventContentEdit(actor, prodId, evId, "draft")).toBe(true);
    // 非线性：details@edit 不给 published 编辑权
    expect(await hasEventContentEdit(actor, prodId, evId, "published")).toBe(false);
    await getPool().query(
      `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'event', $3, 'publication', 'edit', 'direct', $2)`,
      [prodId, userId, evId],
    );
    expect(await hasEventContentEdit(actor, prodId, evId, "published")).toBe(true);
  });
});
