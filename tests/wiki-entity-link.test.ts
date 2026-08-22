import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import {
  createWiki, updateWiki,
  extractMentionEdges, listBacklinks, listWikiRefsForEntity,
} from "@/lib/wiki-db";
import { GET as wikiRefsGET } from "@/app/api/production/[id]/wiki-refs/route";
import { makeProduction, makeScene, cleanupProduction } from "./factories";

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
});
