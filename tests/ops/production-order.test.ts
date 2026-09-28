import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { addProductionMember } from "@/lib/perm/member-db";
import {
  createProduction,
  listMyProductionsWithRoles,
  placeProductionForUser,
} from "@/lib/production/production-db";
import { getPool } from "@/lib/pg";
import { cleanupProduction, shortId } from "../_support/factories";

describe("per-user 项目排序", () => {
  const productionIds = [`ord-${shortId()}`, `ord-${shortId()}`, `ord-${shortId()}`];
  let ownerId = "";
  let memberId = "";

  beforeAll(async () => {
    ownerId = (await upsertFeishuUser(`order-owner-${shortId()}`, "排序 owner", null, false)).userId;
    memberId = (await upsertFeishuUser(`order-member-${shortId()}`, "排序成员", null, false)).userId;
    for (const [index, id] of productionIds.entries()) {
      await createProduction(id, `排序项目 ${index + 1}`, ownerId);
      await addProductionMember(id, memberId);
    }
  });

  afterAll(async () => {
    for (const id of productionIds) await cleanupProduction(id).catch(() => {});
  });

  async function idsFor(userId: string): Promise<string[]> {
    const rows = await listMyProductionsWithRoles(userId, false, []);
    return rows.map(row => row.id).filter(id => productionIds.includes(id));
  }

  it("schema 使用独立的 lex key 表，production 旧排序列已退役", async () => {
    const { rows } = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'user_production_order' ORDER BY ordinal_position`,
    );
    expect(rows.map(row => row.column_name)).toEqual([
      "id", "user_id", "production_id", "sort_key", "updated_at",
    ]);
    const old = await getPool().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'production' AND column_name = 'sort_order'`,
    );
    expect(old.rows).toHaveLength(0);
  });

  it("owner 的排序只影响自己，另一成员保持原默认顺序", async () => {
    const memberBefore = await idsFor(memberId);
    const ownerBefore = await idsFor(ownerId);
    await placeProductionForUser(ownerId, ownerBefore[2], { anchorId: ownerBefore[0], side: "before" });
    expect(await idsFor(ownerId)).toEqual([ownerBefore[2], ownerBefore[0], ownerBefore[1]]);
    expect(await idsFor(memberId)).toEqual(memberBefore);
  });

  it("owner 即使没有 production_member 行也仍可排序", async () => {
    await getPool().query(
      "DELETE FROM production_member WHERE production_id = $1 AND user_id = $2",
      [productionIds[0], ownerId],
    );
    const before = await idsFor(ownerId);
    const moving = productionIds[0];
    const anchor = before.find(id => id !== moving)!;
    await placeProductionForUser(ownerId, moving, { anchorId: anchor, side: "after" });
    const after = await idsFor(ownerId);
    expect(after.indexOf(moving)).toBe(after.indexOf(anchor) + 1);
  });

  it("排序行的 key 合法且同用户不重复", async () => {
    const { rows } = await getPool().query<{ sort_key: string }>(
      `SELECT sort_key FROM user_production_order
       WHERE user_id = $1 AND production_id = ANY($2::text[])`,
      [ownerId, productionIds],
    );
    expect(rows).toHaveLength(3);
    expect(rows.every(row => /^[0-9a-z]{10}$/.test(row.sort_key))).toBe(true);
    expect(new Set(rows.map(row => row.sort_key)).size).toBe(rows.length);
  });
});
