// 通用 node 挂载路由（#420 第二批 PR-B）：POST/DELETE 的 kind 分派双门 +
// by-mount 泛化读面（asset/wiki 各走内容面过滤）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { createWiki } from "@/lib/wiki/content";
import { insertNode } from "@/lib/node/db";
import { getNodeMount } from "@/lib/node/mount";
import { POST as mountsPOST } from "@/app/api/production/[id]/node/[nodeId]/mounts/route";
import { DELETE as mountDELETE } from "@/app/api/production/[id]/node/[nodeId]/mounts/[mountId]/route";
import { GET as byMountGET } from "@/app/api/production/[id]/assets/by-mount/route";
import { POST as assetsPOST } from "@/app/api/production/[id]/assets/route";
import { makeProduction, cleanupProduction, makeScene } from "./factories";

async function newMember(prodId: string): Promise<string> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  const id = res.rows[0].id;
  await pool.query(
    `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')`,
    [prodId, id],
  );
  return id;
}

async function grant(
  userId: string, prodId: string,
  resourceType: string, resourceId: string, sub: string, verb: string,
) {
  await getPool().query(
    `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, $3, $4, $5, $6, 'auto')`,
    [prodId, userId, resourceType, resourceId, sub, verb],
  );
}

const cookieFor = (userId: string) =>
  `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;

function makeReq(method: string, url: string, userId: string, body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookieFor(userId) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

let prodId: string;
let versionId: string;
let author: string;     // 文档创建者（创建者行集含 grants@edit）+ 宿主票
let plain: string;      // 普通成员：无分享面、无宿主票
let sceneId: string;
let wikiId: string;
let docNodeId: string;

beforeAll(async () => {
  ({ prodId, versionId } = await makeProduction());
  [author, plain] = await Promise.all([newMember(prodId), newMember(prodId)]);
  sceneId = await makeScene(prodId, versionId);
  await grant(author, prodId, "scene", sceneId, "mounts", "create");
  await grant(plain, prodId, "scene", sceneId, "mounts", "create"); // 给宿主票，孤立 node 侧门

  const doc = await createWiki({
    productionId: prodId, title: "挂载路由测试文档", createdBy: author, listable: false,
  });
  wikiId = doc.id;
  docNodeId = doc.nodeId;
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("POST /node/[nodeId]/mounts", () => {
  it("未登录 → 401；归档项目 → 403", async () => {
    const url = `/api/production/${prodId}/node/${docNodeId}/mounts`;
    const ctx = { params: Promise.resolve({ id: prodId, nodeId: docNodeId }) };
    const body = { mountType: "scene", mountId: sceneId };

    const anon = await mountsPOST(new NextRequest(`http://localhost${url}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), ctx);
    expect(anon.status).toBe(401);

    await getPool().query(`UPDATE production SET archived_at = now() WHERE id = $1`, [prodId]);
    try {
      const archived = await mountsPOST(makeReq("POST", url, author, body), ctx);
      expect(archived.status).toBe(403);
    } finally {
      await getPool().query(`UPDATE production SET archived_at = NULL WHERE id = $1`, [prodId]);
    }
  });

  it("文档创建者（分享面 ∧ 宿主票）→ 201；普通成员缺分享面 → 403", async () => {
    const url = `/api/production/${prodId}/node/${docNodeId}/mounts`;
    const ctx = { params: Promise.resolve({ id: prodId, nodeId: docNodeId }) };
    const body = { mountType: "scene", mountId: sceneId };

    const denied = await mountsPOST(makeReq("POST", url, plain, body), ctx);
    expect(denied.status).toBe(403);

    const ok = await mountsPOST(makeReq("POST", url, author, body), ctx);
    expect(ok.status).toBe(201);
    const j = await ok.json() as { mount: { id: string; mountType: string } };
    expect(j.mount.mountType).toBe("scene");
  });

  it("folder 节点不可挂载 → 400；embed 不受理 → 400；目标不存在 → 404", async () => {
    const folderId = await insertNode({
      productionId: prodId, kind: "folder", parentId: null, sortKey: null,
      title: "测试夹", listable: true, createdBy: author,
    });
    const fRes = await mountsPOST(
      makeReq("POST", `/api/production/${prodId}/node/${folderId}/mounts`, author,
        { mountType: "scene", mountId: sceneId }),
      { params: Promise.resolve({ id: prodId, nodeId: folderId }) });
    expect(fRes.status).toBe(400);

    const eRes = await mountsPOST(
      makeReq("POST", `/api/production/${prodId}/node/${docNodeId}/mounts`, author,
        { mountType: "embed", mountId: wikiId }),
      { params: Promise.resolve({ id: prodId, nodeId: docNodeId }) });
    expect(eRes.status).toBe(400);

    // 门先于目标校验（与 asset 挂载路由同序）：先给通配宿主票让门过，幽灵目标 404
    await grant(author, prodId, "scene", "*", "mounts", "create");
    const gRes = await mountsPOST(
      makeReq("POST", `/api/production/${prodId}/node/${docNodeId}/mounts`, author,
        { mountType: "scene", mountId: "sc_ghost" }),
      { params: Promise.resolve({ id: prodId, nodeId: docNodeId }) });
    expect(gRes.status).toBe(404);
  });
});

describe("上传指定树位置（assets POST parentNodeId）", () => {
  it("指定 folder 落点 → 壳节点落位且 listable；幽灵父 → 403（落位双门）", async () => {
    await grant(author, prodId, "asset", "*", "*", "create");
    const folderId = await insertNode({
      productionId: prodId, kind: "folder", parentId: null, sortKey: null,
      title: "上传落点夹", listable: true, createdBy: author,
    });
    const url = `/api/production/${prodId}/assets`;
    const ctx = { params: Promise.resolve({ id: prodId }) };

    const ok = await assetsPOST(makeReq("POST", url, author, {
      storageType: "feishu_link", feishuUrl: "https://feishu.example/x",
      fileName: "落位.txt", assetType: "reference",
      parentNodeId: folderId, listable: true,
    }), ctx);
    expect(ok.status).toBe(201);
    const j = await ok.json() as { asset: { id: string } };
    const { rows: [n] } = await getPool().query<{ parent_id: string; listable: boolean }>(
      `SELECT parent_id, listable FROM node WHERE asset_id = $1`, [j.asset.id]);
    expect(n.parent_id).toBe(folderId);
    expect(n.listable).toBe(true);

    const ghost = await assetsPOST(makeReq("POST", url, author, {
      storageType: "feishu_link", feishuUrl: "https://feishu.example/y",
      fileName: "幽灵父.txt", assetType: "reference",
      parentNodeId: "nd_ghost",
    }), ctx);
    expect(ghost.status).toBe(403);
  });
});

describe("by-mount 泛化读面 + DELETE", () => {
  it("挂载点回 wiki 条目（对经让渡可见者）；DELETE 对偶门收回", async () => {
    // author 自己一定可见（创建者行集）；plain 无 wiki 授权也无 scene meta@view
    // ——文档对其不可见，读面应滤掉
    const listUrl = `/api/production/${prodId}/assets/by-mount?type=scene&id=${sceneId}`;
    const listCtx = { params: Promise.resolve({ id: prodId }) };

    const forAuthor = await byMountGET(makeReq("GET", listUrl, author), listCtx);
    const aj = await forAuthor.json() as { results: Array<{ kind: string; wiki: { id: string } | null }> };
    const wikiEntry = aj.results.find(r => r.kind === "wiki");
    expect(wikiEntry?.wiki?.id).toBe(wikiId);

    const forPlain = await byMountGET(makeReq("GET", listUrl, plain), listCtx);
    const pj = await forPlain.json() as { results: Array<{ kind: string }> };
    expect(pj.results.find(r => r.kind === "wiki")).toBeUndefined();

    // DELETE 双侧任一可终止：两侧都无票的 stranger → 403；错配 nodeId → 404；
    // plain 持宿主票（scene mounts@create）→ 宿主侧摘除成立
    const { rows: [m] } = await getPool().query<{ id: string }>(
      `SELECT id FROM node_mount WHERE node_id = $1 AND mount_type = 'scene'`, [docNodeId]);
    const delUrl = `/api/production/${prodId}/node/${docNodeId}/mounts/${m.id}`;

    const mismatch = await mountDELETE(
      makeReq("DELETE", `/api/production/${prodId}/node/${docNodeId}x/mounts/${m.id}`, author),
      { params: Promise.resolve({ id: prodId, nodeId: `${docNodeId}x`, mountId: m.id }) });
    expect(mismatch.status).toBe(404);

    const stranger = await newMember(prodId);
    const denied = await mountDELETE(makeReq("DELETE", delUrl, stranger),
      { params: Promise.resolve({ id: prodId, nodeId: docNodeId, mountId: m.id }) });
    expect(denied.status).toBe(403);

    const viaHost = await mountDELETE(makeReq("DELETE", delUrl, plain),
      { params: Promise.resolve({ id: prodId, nodeId: docNodeId, mountId: m.id }) });
    expect(viaHost.status).toBe(200);
    expect(await getNodeMount(m.id)).toBeNull();
  });
});
