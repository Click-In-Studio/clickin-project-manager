import { beforeAll, afterAll, it, expect } from "vitest";
import { getPool } from "@/lib/pg";
import { createAsset, deleteAsset, getAsset } from "@/lib/asset/db";
import { makeProduction, cleanupProduction } from "../_support/factories";

let prodId: string;
let otherProdId: string;
let targetId: string;
let user: string;

beforeAll(async () => {
  user = (await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id")).rows[0].id;
  ({ prodId } = await makeProduction(user));
  ({ prodId: otherProdId } = await makeProduction(user));
  const makeAsset = (fileName: string) => createAsset({
    productionId: prodId, uploaderUserId: user, assetType: "reference",
    fileName, mimeType: "application/pdf", storageType: "r2",
  });
  targetId = (await makeAsset("待删除.pdf")).asset.id;
  await makeAsset("保留.pdf");
  await getPool().query(
    `UPDATE production_member_grant SET is_revoked=true,revoked_reason='role_change'
     WHERE production_id=$1 AND resource_id=$2 AND resource_sub='file' AND permission_level='view'`, [prodId,targetId],
  );
  await getPool().query(
    `INSERT INTO production_member_grant
     (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source)
     VALUES ($1,$3,'asset','*','meta','view','approval'),
            ($1,$3,'wiki',$4,'meta','view','direct'),
            ($2,$3,'asset',$4,'meta','view','direct')`, [prodId,otherProdId,user,targetId],
  );
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await cleanupProduction(otherProdId).catch(() => {});
});

it("资产删除与实例授权撤销同事务，不删审计行、不动通配、其它实例、类型和项目", async () => {
  const rows = async () => (await getPool().query<{ row: Record<string, unknown> }>(
    "SELECT to_jsonb(g) AS row FROM production_member_grant g WHERE production_id=ANY($1::text[]) ORDER BY id", [[prodId,otherProdId]],
  )).rows.map(r => r.row);
  const before = await rows();
  const eligible = before.filter(r => r.production_id===prodId && r.resource_type==='asset'
    && r.resource_id===targetId && !r.is_revoked);
  expect(eligible.length).toBeGreaterThan(0);
  await deleteAsset(targetId);
  expect(await getAsset(targetId)).toBeNull();
  const expected = before.map(r => eligible.includes(r) ? { ...r,is_revoked:true,revoked_reason:"manual" } : r);
  expect(await rows()).toEqual(expected);
  await deleteAsset(targetId);
  expect(await rows()).toEqual(expected);
});
