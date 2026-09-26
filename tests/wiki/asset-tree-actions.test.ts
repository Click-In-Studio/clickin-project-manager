import { afterAll, beforeAll, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { insertNode } from "@/lib/node/db";
import { createAsset } from "@/lib/asset/db";
import { listNodeTreeFor, listDramaturgyTreeFor } from "@/lib/node/tree-view";
import { makeProduction, cleanupProduction } from "../_support/factories";

let prodId: string;
let uploader: string;
let editor: string;
let deleter: string;
let assetId: string;
let scopeId: string;
let scopedAssetId: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  [uploader, editor, deleter] = (await getPool().query<{ id: string }>(
    "INSERT INTO app_user (id) SELECT gen_random_uuid() FROM generate_series(1,3) RETURNING id",
  )).rows.map(r => r.id);
  const created = await createAsset({
    productionId: prodId, uploaderUserId: uploader, assetType: "reference",
    fileName: "菜单授权.pdf", mimeType: "application/pdf", storageType: "r2", listable: true,
  });
  assetId = created.asset.id;
  scopeId = await insertNode({
    productionId: prodId, kind: "folder", title: "测试作用域", listable: true,
    parentId: null, sortKey: null, createdBy: uploader,
  });
  scopedAssetId = (await createAsset({
    productionId: prodId, uploaderUserId: uploader, assetType: "reference",
    fileName: "作用域内.pdf", mimeType: "application/pdf", storageType: "r2",
    nodeParentId: scopeId, listable: true,
  })).asset.id;
  // 撤掉上传者写权，验证不会通过 created_by 重新点亮菜单。
  await getPool().query(
    `UPDATE production_member_grant SET is_revoked=true
     WHERE production_id=$1 AND user_id=$2 AND permission_level IN ('edit','delete')`, [prodId,uploader],
  );
  for (const [user, sub, verb] of [[editor,"meta","edit"],[deleter,"*","delete"]]) {
    await getPool().query(
      `INSERT INTO production_member_grant
        (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source)
       VALUES ($1,$2,'asset',$3,$4,$5,'auto')`, [prodId,user,assetId,sub,verb],
    );
  }
});

afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });
const actor = (userId: string) => ({ userId, isAdmin: false, isOwner: false });

it("完整目录按两枚独立权限返回菜单动作，上传者无身份兜底", async () => {
  for (const [user, rename, del] of [[uploader,false,false],[editor,true,false],[deleter,false,true]] as const) {
    const tree = await listNodeTreeFor(actor(user), prodId);
    expect(tree.nodes.some(n => n.assetId === assetId)).toBe(true);
    expect(tree.assetActions[assetId]).toEqual({ rename, delete: del });
  }
});

it("owner 的集合权限与路由旁路一致", async () => {
  const tree = await listNodeTreeFor({ ...actor(uploader), isOwner: true }, prodId);
  expect(tree.assetActions[assetId]).toEqual({ rename: true, delete: true });
});

it("作用域目录给其中的资产返回真实权限，不混入其他目录的资产", async () => {
  await getPool().query(
    `INSERT INTO production_member_grant
      (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source)
     VALUES ($1,$2,'asset',$3,'meta','edit','auto')`, [prodId,editor,scopedAssetId],
  );
  const tree = await listDramaturgyTreeFor(actor(editor), prodId, scopeId);
  expect(tree.nodes.some(n => n.assetId === scopedAssetId)).toBe(true);
  expect(tree.assetActions).toEqual({ [scopedAssetId]: { rename: true, delete: false } });
});

it("过期写权不点亮菜单；file@edit 不代替 meta@edit", async () => {
  await getPool().query(
    `INSERT INTO production_member_grant
      (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source,expires_at)
     VALUES ($1,$2,'asset',$3,'meta','edit','auto',now()-interval '1 day'),
            ($1,$2,'asset',$3,'file','edit','auto',NULL)`, [prodId,deleter,assetId],
  );
  const tree = await listNodeTreeFor(actor(deleter), prodId);
  expect(tree.assetActions[assetId]).toEqual({ rename: false, delete: true });
});
