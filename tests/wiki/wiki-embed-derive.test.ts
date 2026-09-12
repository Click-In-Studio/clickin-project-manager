// embed 挂载边服务端派生（嵌入语法收敛轮）：正文是唯一真相——保存时 syncWikiLinks
// 从 ![](/__cm__/asset/<id>) 派生 node_mount('embed')，移除即回收；新增过 asset 侧
// publication@create 门（与 mounts API 双门同源），把别人 asset 的 URI 抄进正文
// 不构成让渡。原先由编辑器插图时"尽力而为"补打 mounts API 的路径已删除。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { createAsset } from "@/lib/asset/db";
import { createWiki, updateWiki } from "@/lib/wiki/content";
import { extractEmbedAssetIds } from "@/lib/wiki/links";
import { POST as assetMountsPOST } from "@/app/api/production/[id]/assets/[assetId]/mounts/route";
import { GET as previewUrlGET } from "@/app/api/production/[id]/assets/[assetId]/preview-url/route";
import { makeProduction, cleanupProduction } from "../_support/factories";

const cookieFor = (userId: string) =>
  `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;

function makeReq(method: string, url: string, userId: string, body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookieFor(userId) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function newMember(prodId: string): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  const uid = res.rows[0].id;
  await getPool().query(
    `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')`,
    [prodId, uid],
  );
  return uid;
}

async function embedMounts(wikiId: string): Promise<{ assetId: string; createdBy: string }[]> {
  const res = await getPool().query<{ asset_id: string; created_by: string }>(
    `SELECT n.asset_id, nm.created_by FROM node_mount nm
     JOIN node n ON n.id = nm.node_id
     WHERE nm.mount_type = 'embed' AND nm.mount_id = $1
     ORDER BY n.asset_id`,
    [wikiId],
  );
  return res.rows.map(r => ({ assetId: r.asset_id, createdBy: r.created_by }));
}

let prodId: string;
let ownerId: string;
let uploader: string;
let stranger: string;
let assetId: string;
const users: string[] = [];

beforeAll(async () => {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  ownerId = res.rows[0].id;
  users.push(ownerId);
  ({ prodId } = await makeProduction(ownerId));
  uploader = await newMember(prodId);
  stranger = await newMember(prodId);
  users.push(uploader, stranger);
  ({ asset: { id: assetId } } = await createAsset({
    productionId: prodId, uploaderUserId: uploader, assetType: "reference",
    fileName: "嵌入测试.png", mimeType: "image/png", storageType: "r2", r2Key: `test/${prodId}/embed.png`,
  }));
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1)", [users]).catch(() => {});
});

describe("extractEmbedAssetIds", () => {
  it("认嵌入形态（含 v1 冒号），不认 chip 引用，剥代码上下文", () => {
    const body = [
      "![图](/__cm__/asset/ast_aaa)",
      "[#](/__cm__/asset/ast_chip?aux=scene:sc_1)",        // 引用不是嵌入
      "![旧](/__cm__asset:ast_legacy)",                     // v1 只读兼容
      "`![码](/__cm__/asset/ast_code)`",                    // 行内码是文档不是引用
      "```\n![栅](/__cm__/asset/ast_fence)\n```",
      "![again](/__cm__/asset/ast_aaa?v=whatever)",         // 去重 + 参数剥离
    ].join("\n\n");
    expect(extractEmbedAssetIds(body).sort()).toEqual(["ast_aaa", "ast_legacy"]);
  });
});

describe("embed mount derivation", () => {
  it("上传者本人保存嵌入 → 派生 embed 边；移除 → 回收；重加 → 复原", async () => {
    const w = await createWiki({
      productionId: prodId, title: "嵌图文档",
      body: `开场\n\n![图](/__cm__/asset/${assetId})\n\n收场`,
      createdBy: uploader,
    });
    expect(await embedMounts(w.id)).toEqual([{ assetId, createdBy: uploader }]);

    await updateWiki(w.id, prodId, { body: "图删掉了" }, uploader);
    expect(await embedMounts(w.id)).toEqual([]);

    await updateWiki(w.id, prodId, { body: `又加回来 ![图](/__cm__/asset/${assetId})` }, uploader);
    expect(await embedMounts(w.id)).toEqual([{ assetId, createdBy: uploader }]);
  });

  it("无 publication@create 者抄别人 asset 的嵌入 URI → 不落边（不构成让渡）", async () => {
    const w = await createWiki({
      productionId: prodId, title: "抄来的图",
      body: `![偷图](/__cm__/asset/${assetId})`,
      createdBy: stranger,
    });
    expect(await embedMounts(w.id)).toEqual([]);
    // 同一正文再保存一次也不落（reconcile 幂等，不因重试放水）
    await updateWiki(w.id, prodId, { body: `![偷图](/__cm__/asset/${assetId}) 加句话` }, stranger);
    expect(await embedMounts(w.id)).toEqual([]);
  });

  it("owner 旁路：owner 嵌入别人的 asset → 落边", async () => {
    const w = await createWiki({
      productionId: prodId, title: "owner 嵌图",
      body: `![图](/__cm__/asset/${assetId})`,
      createdBy: ownerId,
    });
    expect(await embedMounts(w.id)).toEqual([{ assetId, createdBy: ownerId }]);
  });

  it("v1 冒号形态（历史正文/回滚兜底）同样派生", async () => {
    const w = await createWiki({
      productionId: prodId, title: "旧形态",
      body: `![旧](/__cm__asset:${assetId})`,
      createdBy: uploader,
    });
    expect(await embedMounts(w.id)).toEqual([{ assetId, createdBy: uploader }]);
  });

  it("chip 引用（无 ! 前缀）落 wiki_entity_link 但不派生 embed 边", async () => {
    const w = await createWiki({
      productionId: prodId, title: "只引用不嵌入",
      body: `[#](/__cm__/asset/${assetId})`,
      createdBy: uploader,
    });
    expect(await embedMounts(w.id)).toEqual([]);
    const edges = await getPool().query(
      `SELECT 1 FROM wiki_entity_link WHERE wiki_id = $1::uuid AND entity_type = 'asset' AND entity_id = $2`,
      [w.id, assetId],
    );
    expect(edges.rows.length).toBe(1);
  });

  it("embed 是派生数据：asset mounts 路由拒收直写（单写入方契约）", async () => {
    const w = await createWiki({
      productionId: prodId, title: "直写靶子", body: "", createdBy: uploader,
    });
    const res = await assetMountsPOST(
      makeReq("POST", `/api/production/${prodId}/assets/${assetId}/mounts`, uploader,
        { mountType: "embed", mountId: w.id }),
      { params: Promise.resolve({ id: prodId, assetId }) },
    );
    expect(res.status).toBe(400);
  });

  it("preview-url 过 meta 门：无票成员 403（此前只查成员身份即放行）", async () => {
    const ctx = { params: Promise.resolve({ id: prodId, assetId }) };
    const denied = await previewUrlGET(
      makeReq("GET", `/api/production/${prodId}/assets/${assetId}/preview-url`, stranger), ctx);
    expect(denied.status).toBe(403);
    const ok = await previewUrlGET(
      makeReq("GET", `/api/production/${prodId}/assets/${assetId}/preview-url`, uploader), ctx);
    expect(ok.status).toBe(200);
  });

  it("嵌入同时照落 asset 引用边（边表不区分 ! 前缀，行为保真）", async () => {
    const w = await createWiki({
      productionId: prodId, title: "嵌入也是引用",
      body: `![图](/__cm__/asset/${assetId})`,
      createdBy: uploader,
    });
    const edges = await getPool().query(
      `SELECT origin FROM wiki_entity_link WHERE wiki_id = $1::uuid AND entity_type = 'asset' AND entity_id = $2`,
      [w.id, assetId],
    );
    expect(edges.rows.map(r => r.origin)).toEqual(["wiki_body"]);
  });
});
