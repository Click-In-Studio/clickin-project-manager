import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import {
  createWiki, updateWiki, deleteWiki,
  extractMentionEdges, listBacklinks, listWikiRefsForEntity, listEntityRefsForWiki,
  ensureDramaturgyRootAnchor,
} from "@/lib/wiki-db";
import { GET as wikiRefsGET, POST as wikiRefsPOST, DELETE as wikiRefsDELETE } from "@/app/api/production/[id]/wiki-refs/route";
import { makeProduction, makeScene, cleanupProduction, shortId } from "./factories";

// wiki↔entity 引用边（wiki_entity_link）：提取全 kind、派生重建只清 body 边、
// 跨剧组防泄漏、对象侧反向面板端点的门。设计要点见 db/migrate-wiki-entity-link.sql。

async function newMember(prodId: string): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  const uid = res.rows[0].id;
  await getPool().query(
    `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')`,
    [prodId, uid],
  );
  return uid;
}

let prodId: string;
let versionId: string;
let sceneId: string;
let creator: string;
let stranger: string;
const users: string[] = [];

beforeAll(async () => {
  ({ prodId, versionId } = await makeProduction());
  sceneId = await makeScene(prodId, versionId);
  creator = await newMember(prodId);
  stranger = await newMember(prodId);
  users.push(creator, stranger);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1)", [users]).catch(() => {});
});

describe("extractMentionEdges", () => {
  it("extracts all edge kinds; page skipped; block.<mode> normalized; version/aux stripped", () => {
    const w = "AAAAAAAA-2222-3333-4444-555555555555";
    const body = [
      `旧式 [#wiki:${w}]`,
      "[第3场](/__cm__scene:sc_abc?v=ver_1)",
      "[台词](/__cm__block.page:blk_1?v=ver_1)",
      "[排练标记](/__cm__rehearsal:blk_2)",
      "[Q](/__cm__cue:cue_9)",
      "[图纸](/__cm__asset:as_7:scene:sc_abc)",
      "[p.3](/__cm__page:3)",
      "[外链](https://example.com)",
    ].join("\n");
    expect(extractMentionEdges(body).sort((a, b) => a.entityType.localeCompare(b.entityType))).toEqual([
      { entityType: "asset", entityId: "as_7" },
      { entityType: "block", entityId: "blk_1" },
      { entityType: "cue", entityId: "cue_9" },
      { entityType: "rehearsal", entityId: "blk_2" },
      { entityType: "scene", entityId: "sc_abc" },
      { entityType: "wiki", entityId: w.toLowerCase() },
    ]);
  });

  it("ignores mention syntax inside code fences and inline code", () => {
    const body = "示例：`[x](/__cm__scene:sc_doc)`\n```\n[y](/__cm__cue:cue_doc)\n```\n真引用 [z](/__cm__scene:sc_real)";
    expect(extractMentionEdges(body)).toEqual([{ entityType: "scene", entityId: "sc_real" }]);
  });
});

describe("sync on save", () => {
  it("body mention of a scene lands an edge; removing it clears the edge", async () => {
    const doc = await createWiki({
      productionId: prodId, title: "场景笔记",
      body: `关于 [第1场](/__cm__scene:${sceneId}) 的记录`, createdBy: creator,
    });
    expect((await listWikiRefsForEntity(prodId, "scene", sceneId)).map(r => r.id)).toContain(doc.id);

    await updateWiki(doc.id, prodId, { body: "不再引用" }, creator);
    expect((await listWikiRefsForEntity(prodId, "scene", sceneId)).map(r => r.id)).not.toContain(doc.id);
  });

  it("manual edges survive body resync; duplicate body+manual edge dedupes in reads", async () => {
    const doc = await createWiki({ productionId: prodId, title: "手动挂链", createdBy: creator });
    const target = await createWiki({ productionId: prodId, title: "被链目标", createdBy: creator });
    await getPool().query(
      `INSERT INTO wiki_entity_link (wiki_id, production_id, entity_type, entity_id, origin, created_by)
       VALUES ($1::uuid, $2, 'scene', $3, 'manual', $4::uuid)`,
      [doc.id, prodId, sceneId, creator],
    );
    // 正文保存触发全删全插重建——manual 边必须原样存活
    await updateWiki(doc.id, prodId, { body: `引用 [#wiki:${target.id}]` }, creator);
    expect((await listWikiRefsForEntity(prodId, "scene", sceneId)).map(r => r.id)).toContain(doc.id);
    expect((await listBacklinks(target.id, prodId)).map(r => r.id)).toContain(doc.id);

    // body 边与 manual 边并存同一目标 → 读取端去重
    await updateWiki(doc.id, prodId, { body: `[场](/__cm__scene:${sceneId})` }, creator);
    const rows = await getPool().query(
      `SELECT origin FROM wiki_entity_link WHERE wiki_id = $1::uuid AND entity_type = 'scene' AND entity_id = $2`,
      [doc.id, sceneId]);
    expect(rows.rows.map(r => r.origin).sort()).toEqual(["manual", "wiki_body"]);
    const refs = await listWikiRefsForEntity(prodId, "scene", sceneId);
    expect(refs.filter(r => r.id === doc.id)).toHaveLength(1);
  });

  it("deleting a target wiki clears entity-side edges pointing at it (review #303-2)", async () => {
    const target = await createWiki({ productionId: prodId, title: "将被删目标", createdBy: creator });
    await createWiki({
      productionId: prodId, title: "指向者", body: `[#wiki:${target.id}]`, createdBy: creator });
    expect((await listBacklinks(target.id, prodId)).length).toBeGreaterThan(0);

    expect(await deleteWiki(target.id, prodId)).toEqual({ ok: true });
    const leftover = await getPool().query(
      `SELECT 1 FROM wiki_entity_link WHERE entity_type = 'wiki' AND entity_id = $1`, [target.id]);
    expect(leftover.rows).toHaveLength(0);
  });

  it("cross-production mention never surfaces on the target production's side", async () => {
    const other = await makeProduction();
    try {
      const foreignScene = await makeScene(other.prodId, other.versionId);
      await createWiki({
        productionId: prodId, title: "越界引用",
        body: `[偷看](/__cm__scene:${foreignScene})`, createdBy: creator,
      });
      // 边行带来源剧组 id——目标剧组侧查询查不到它
      expect(await listWikiRefsForEntity(other.prodId, "scene", foreignScene)).toEqual([]);
    } finally {
      await cleanupProduction(other.prodId).catch(() => {});
    }
  });
});

describe("GET /wiki-refs", () => {
  const cookieFor = (userId: string) =>
    `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;
  const makeReq = (query: string, userId?: string) =>
    new NextRequest(`http://localhost/api/production/${prodId}/wiki-refs?${query}`, {
      headers: userId ? { Cookie: cookieFor(userId) } : {},
    });
  const ctx = () => ({ params: Promise.resolve({ id: prodId }) });

  it("rejects anonymous (401) and unknown entity type (400)", async () => {
    expect((await wikiRefsGET(makeReq(`type=scene&id=${sceneId}`), ctx())).status).toBe(401);
    expect((await wikiRefsGET(makeReq("type=production&id=x", creator), ctx())).status).toBe(400);
  });

  it("scene refs gated by script blocks@view; wiki titles listed without wiki-visibility filter", async () => {
    const doc = await createWiki({
      productionId: prodId, title: "私有但标题可见",
      body: `[场](/__cm__scene:${sceneId})`, createdBy: creator,
    });
    // 无剧本权限的成员 → 403（门=宿主对象可见性）
    expect((await wikiRefsGET(makeReq(`type=scene&id=${sceneId}`, stranger), ctx())).status).toBe(403);

    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'script', '*', 'blocks', 'view', 'direct', $2)`,
      [prodId, stranger],
    );
    const res = await wikiRefsGET(makeReq(`type=scene&id=${sceneId}`, stranger), ctx());
    expect(res.status).toBe(200);
    const data = await res.json();
    // stranger 对该 wiki 无可见性，但标题级列出（§4.1 名字不敏感、内容敏感）
    expect((data.refs as { id: string; title: string | null }[]).map(r => r.id)).toContain(doc.id);
  });

  it("cue refs gated by the hosting cue_list's cues@view", async () => {
    const cueListId = `t${shortId()}`;
    const cueId = `tcue${shortId()}`;
    await getPool().query(
      "INSERT INTO cue_list (id, production_id, name, notes, created_by) VALUES ($1, $2, 'Q表', '', $3)",
      [cueListId, prodId, creator]);
    await getPool().query(
      `INSERT INTO cue (id, cue_list_id, number, start_kind, end_kind) VALUES ($1, $2, '1', 'gap', 'gap')`,
      [cueId, cueListId]);
    const doc = await createWiki({
      productionId: prodId, title: "cue 笔记", body: `[Q1](/__cm__cue:${cueId})`, createdBy: creator });

    // 无 cue 域权限的成员 → 403
    expect((await wikiRefsGET(makeReq(`type=cue&id=${cueId}`, creator), ctx())).status).toBe(403);

    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'cue_list', $3, 'cues', 'view', 'direct', $2)`,
      [prodId, creator, cueListId]);
    const res = await wikiRefsGET(makeReq(`type=cue&id=${cueId}`, creator), ctx());
    expect(res.status).toBe(200);
    expect(((await res.json()).refs as { id: string }[]).map(r => r.id)).toContain(doc.id);
  });

  it("asset refs: foreign-production asset id → 403 (ownership check)", async () => {
    const other = await makeProduction();
    try {
      const foreignAssetId = `as_${shortId()}`;
      await getPool().query(
        `INSERT INTO asset (id, production_id, uploader_user_id, file_name, storage_type)
         VALUES ($1, $2, $3, 'x.png', 'r2')`,
        [foreignAssetId, other.prodId, creator]);
      expect((await wikiRefsGET(makeReq(`type=asset&id=${foreignAssetId}`, creator), ctx())).status).toBe(403);
    } finally {
      await cleanupProduction(other.prodId).catch(() => {});
    }
  });
});

describe("manual edges & dramaturgy root (Phase 2)", () => {
  const cookieFor = (userId: string) =>
    `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;
  const ctx = () => ({ params: Promise.resolve({ id: prodId }) });
  const post = (userId: string, body: unknown) => wikiRefsPOST(
    new NextRequest(`http://localhost/api/production/${prodId}/wiki-refs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieFor(userId) },
      body: JSON.stringify(body),
    }), ctx());
  const del = (userId: string, qs: string) => wikiRefsDELETE(
    new NextRequest(`http://localhost/api/production/${prodId}/wiki-refs?${qs}`, {
      method: "DELETE", headers: { Cookie: cookieFor(userId) },
    }), ctx());

  let linker: string;

  beforeAll(async () => {
    linker = await newMember(prodId);
    users.push(linker);
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'script', '*', 'blocks', 'view', 'direct', $2)`,
      [prodId, linker]);
  });

  it("POST rejects missing payload (400) and host-gate failure (403)", async () => {
    expect((await post(linker, { entityType: "scene", entityId: sceneId })).status).toBe(400);
    const noPerm = await newMember(prodId);
    users.push(noPerm);
    const doc = await createWiki({ productionId: prodId, title: "无权链", createdBy: noPerm });
    expect((await post(noPerm, { entityType: "scene", entityId: sceneId, wikiId: doc.id })).status).toBe(403);
  });

  it("link existing doc → manual chip; DELETE removes only manual, body edge untouched", async () => {
    const doc = await createWiki({
      productionId: prodId, title: "手动链接目标",
      body: `正文也提了 [场](/__cm__scene:${sceneId})`, createdBy: linker,
    });
    expect((await post(linker, { entityType: "scene", entityId: sceneId, wikiId: doc.id })).status).toBe(201);
    let refs = await listWikiRefsForEntity(prodId, "scene", sceneId);
    expect(refs.find(r => r.id === doc.id)?.manual).toBe(true);

    // 解除 manual：body 边仍在 → chip 保留但 manual=false
    expect((await del(linker, `type=scene&id=${sceneId}&wikiId=${doc.id}`)).status).toBe(200);
    refs = await listWikiRefsForEntity(prodId, "scene", sceneId);
    expect(refs.find(r => r.id === doc.id)?.manual).toBe(false);
  });

  it("linking a doc the actor cannot view → 403 (wiki-side gate)", async () => {
    const secret = await createWiki({ productionId: prodId, title: "别人的私有文档", createdBy: creator });
    expect((await post(linker, { entityType: "scene", entityId: sceneId, wikiId: secret.id })).status).toBe(403);
  });

  it("create-and-link: gated by wiki create; doc lands under 「戏剧构作」 root with a manual edge", async () => {
    expect((await post(linker, { entityType: "scene", entityId: sceneId, createTitle: "第1场 · 大纲" })).status).toBe(403);

    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'wiki', '*', '*', 'create', 'direct', $2)`,
      [prodId, linker]);
    const res = await post(linker, { entityType: "scene", entityId: sceneId, createTitle: "第1场 · 大纲" });
    expect(res.status).toBe(201);
    const { wiki } = await res.json();

    const root = await getPool().query<{ id: string; title: string; is_public: boolean }>(
      `SELECT w.id::text AS id, w.title, w.is_public FROM production_wiki_config c
       JOIN wiki w ON w.id = c.dramaturgy_root_wiki_id WHERE c.production_id = $1`,
      [prodId]);
    expect(root.rows[0].title).toBe("戏剧构作");
    expect(root.rows[0].is_public).toBe(true);
    expect(wiki.parentId).toBe(root.rows[0].id);
    expect((await listWikiRefsForEntity(prodId, "scene", sceneId)).find(r => r.id === wiki.id)?.manual).toBe(true);

    // 懒建幂等 + 锚点删除保护
    expect(await ensureDramaturgyRootAnchor(prodId)).toBe(root.rows[0].id);
    expect(await deleteWiki(root.rows[0].id, prodId)).toEqual({ ok: false, reason: "anchor" });
  });

  it("listEntityRefsForWiki: non-wiki out-edges with manual flag, wiki kind excluded", async () => {
    const target = await createWiki({ productionId: prodId, title: "出边目标", createdBy: linker });
    const doc = await createWiki({
      productionId: prodId, title: "出边来源",
      body: `[场](/__cm__scene:${sceneId}) 与 [#wiki:${target.id}]`, createdBy: linker,
    });
    await post(linker, { entityType: "scene", entityId: sceneId, wikiId: doc.id });
    const refs = await listEntityRefsForWiki(doc.id, prodId);
    expect(refs).toEqual([{ entityType: "scene", entityId: sceneId, manual: true }]);
  });
});
