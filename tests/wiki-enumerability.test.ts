import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import {
  createWiki, updateWiki, getWiki, setWikiPublic, setWikiListable, setWikiDeptShares,
  listWikiLibrary, isWikiAnchor, ensureDramaturgyRootAnchor,
} from "@/lib/wiki-db";
import {
  canViewWiki, listEnumerableWikiIds, canEnumerateWiki, canPlaceWikiUnder, canWriteWikiContainer,
} from "@/lib/wiki-perm";
import { WIKI_LEVEL_ROW_SETS } from "@/lib/resource-grant-db";
import { GET as wikiListGET, POST as wikiPOST } from "@/app/api/production/[id]/wiki/route";
import { PATCH as wikiPATCH } from "@/app/api/production/[id]/wiki/[wikiId]/route";
import { wikiProposeCreate, wikiProposeMove } from "@/lib/mcp/wiki-tools";
import { makeProduction, cleanupProduction } from "./factories";

// #357 枚举面：目录树可见性，与内容面（canViewWiki）正交。
//
//   可枚举(u, X) ⟺ 可枚举(u, parent(X)) ∧ (X.listable ∨ u 持 wiki/X meta@view 行)
//
// 前置合取项＝不变量 E(子) ⊆ E(父)，它保证任何人的枚举集都是**含根的连通子树**。

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}
async function newMember(prodId: string): Promise<string> {
  const uid = await newUser();
  await getPool().query(
    `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')`,
    [prodId, uid],
  );
  return uid;
}
const actorOf = (userId: string) => ({ userId, isAdmin: false, isOwner: false });

/** 发一档个人分享行集（含 meta@view）。 */
async function shareTo(
  prodId: string, wikiId: string, userId: string, level: "view" | "edit" | "manage" = "view",
) {
  for (const [sub, verb] of WIKI_LEVEL_ROW_SETS[level]) {
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'wiki', $3, $4, $5, 'direct', $2)`,
      [prodId, userId, wikiId, sub, verb]);
  }
}

let prodId: string;
let creator: string;
let member: string;
let lawyer: string;
const users: string[] = [];

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  creator = await newMember(prodId);
  member = await newMember(prodId);
  lawyer = await newMember(prodId);
  users.push(creator, member, lawyer);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1)", [users]).catch(() => {});
});

describe("schema", () => {
  it("wiki.listable exists and defaults to true", async () => {
    const { rows } = await getPool().query<{ column_default: string | null; is_nullable: string }>(
      `SELECT column_default, is_nullable FROM information_schema.columns
       WHERE table_name = 'wiki' AND column_name = 'listable'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].column_default).toContain("true");
  });

  it("createWiki defaults listable = true", async () => {
    const w = await createWiki({ productionId: prodId, title: "默认进目录", createdBy: creator });
    expect(w.listable).toBe(true);
  });
});

describe("不变量 E(子) ⊆ E(父)", () => {
  it("隐一个节点即隐整棵子树，且零级联写（子节点 listable 仍为 true）", async () => {
    // 「与某某工作室的演出合作」（公开可枚举）→「法律文件」（不可枚举）→「合同v3」
    const collab = await createWiki({ productionId: prodId, title: "与某某工作室的演出合作", createdBy: creator });
    await setWikiPublic(collab.id, prodId, true);
    const legal = await createWiki({
      productionId: prodId, title: "法律文件", parentId: collab.id, createdBy: creator, listable: false });
    const contract = await createWiki({
      productionId: prodId, title: "合同v3", parentId: legal.id, createdBy: creator });

    expect(contract.listable).toBe(true);           // 子节点自己没被改过
    expect(await canEnumerateWiki(actorOf(member), prodId, collab.id)).toBe(true);
    expect(await canEnumerateWiki(actorOf(member), prodId, legal.id)).toBe(false);
    expect(await canEnumerateWiki(actorOf(member), prodId, contract.id)).toBe(false);

    // 被显式分享的人：法律文件及其子树都回来了（祖先链在公开合作页上，通）
    await shareTo(prodId, legal.id, lawyer);
    expect(await canEnumerateWiki(actorOf(lawyer), prodId, legal.id)).toBe(true);
    expect(await canEnumerateWiki(actorOf(lawyer), prodId, contract.id)).toBe(true);
  });

  it("枚举集在 parent_id 上恒为含根的连通子树（不可能出现断链）", async () => {
    // 随机深浅不一的树 + 随意撒 listable=false / 个人分享，断言不变量
    const roots = await Promise.all([0, 1].map(i =>
      createWiki({ productionId: prodId, title: `连通根${i}`, createdBy: creator })));
    const mid = await Promise.all(roots.map((r, i) =>
      createWiki({
        productionId: prodId, title: `连通中${i}`, parentId: r.id,
        createdBy: creator, listable: i % 2 === 1 })));   // 中0 隐、中1 显
    const leaves = await Promise.all(mid.map((m, i) =>
      createWiki({ productionId: prodId, title: `连通叶${i}`, parentId: m.id, createdBy: creator })));
    await shareTo(prodId, leaves[0].id, member);   // 只分享叶子，祖先链不给

    const e = await listEnumerableWikiIds(actorOf(member), prodId);
    expect(e.wildcard).toBe(false);
    const all = await listWikiLibrary(prodId);
    const parentOf = new Map(all.map(w => [w.id, w.parentId]));
    for (const id of e.ids) {
      const parent = parentOf.get(id);
      if (parent) expect(e.ids.has(parent)).toBe(true);   // ← 不变量
    }
    // 单给叶子发行不足以让它进树——祖先链被中间那层挡着
    expect(e.ids.has(leaves[0].id)).toBe(false);
  });
});

describe("两个面正交", () => {
  it("可枚举 ≠ 可读：默认私密文档在树里有名字，内容仍 403", async () => {
    const w = await createWiki({ productionId: prodId, title: "名字可见正文不可见", createdBy: creator });
    expect(await canEnumerateWiki(actorOf(member), prodId, w.id)).toBe(true);
    expect(await canViewWiki(actorOf(member), prodId, w.id)).toBe(false);
  });

  it("可读 ≠ 可枚举：公开但不可枚举＝靠链接传播", async () => {
    const w = await createWiki({
      productionId: prodId, title: "公开但不在目录", createdBy: creator, listable: false });
    await setWikiPublic(w.id, prodId, true);
    expect(await canViewWiki(actorOf(member), prodId, w.id)).toBe(true);
    expect(await canEnumerateWiki(actorOf(member), prodId, w.id)).toBe(false);
  });

  it("不变量：翻转 listable 不改变 canViewWiki 的判定", async () => {
    const pub = await createWiki({ productionId: prodId, title: "内容面不受枚举面影响", createdBy: creator });
    await setWikiPublic(pub.id, prodId, true);
    const before = await canViewWiki(actorOf(member), prodId, pub.id);
    await setWikiListable(pub.id, prodId, false);
    expect(await canViewWiki(actorOf(member), prodId, pub.id)).toBe(before);
    await setWikiListable(pub.id, prodId, true);
    expect(await canViewWiki(actorOf(member), prodId, pub.id)).toBe(before);
  });

  it("部门分享与个人分享对称：定向分享 ⇒ 可枚举，退组即刻收缩", async () => {
    const w = await createWiki({
      productionId: prodId, title: "部门定向分享", createdBy: creator, listable: false });
    const { rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
      `INSERT INTO production_dept (production_id, name) VALUES ($1, '枚举面道具组') RETURNING id`, [prodId]);
    await setWikiDeptShares(w.id, prodId, [deptId]);
    expect(await canEnumerateWiki(actorOf(member), prodId, w.id)).toBe(false);

    await getPool().query(
      `INSERT INTO production_dept_member (production_id, dept_id, user_id) VALUES ($1, $2, $3)`,
      [prodId, deptId, member]);
    expect(await canEnumerateWiki(actorOf(member), prodId, w.id)).toBe(true);
    expect(await canViewWiki(actorOf(member), prodId, w.id)).toBe(true);

    await getPool().query(
      `DELETE FROM production_dept_member WHERE dept_id = $1 AND user_id = $2`, [deptId, member]);
    expect(await canEnumerateWiki(actorOf(member), prodId, w.id)).toBe(false);
  });

  it("部门分享同样受祖先链约束（不能凭分享穿透隐藏的父）", async () => {
    const hiddenParent = await createWiki({
      productionId: prodId, title: "部门面隐藏父", createdBy: creator, listable: false });
    const child = await createWiki({
      productionId: prodId, title: "部门面子文档", parentId: hiddenParent.id, createdBy: creator });
    const { rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
      `INSERT INTO production_dept (production_id, name) VALUES ($1, '枚举面服装组') RETURNING id`, [prodId]);
    await setWikiDeptShares(child.id, prodId, [deptId]);
    await getPool().query(
      `INSERT INTO production_dept_member (production_id, dept_id, user_id) VALUES ($1, $2, $3)`,
      [prodId, deptId, member]);
    expect(await canViewWiki(actorOf(member), prodId, child.id)).toBe(true);
    expect(await canEnumerateWiki(actorOf(member), prodId, child.id)).toBe(false);
  });

  it("is_public 刻意不蕴含可枚举（泛在开关各管各的面）", async () => {
    const w = await createWiki({
      productionId: prodId, title: "泛在开关正交", createdBy: creator, listable: false });
    await setWikiPublic(w.id, prodId, true);
    expect(await canViewWiki(actorOf(member), prodId, w.id)).toBe(true);
    expect(await canEnumerateWiki(actorOf(member), prodId, w.id)).toBe(false);
  });

  it("内容可读者只要祖先链通就在树里（*@view 的 sub 通配天然命中 meta，装门零迁移）", async () => {
    const w = await createWiki({
      productionId: prodId, title: "分享即可枚举", createdBy: creator, listable: false });
    expect(await canEnumerateWiki(actorOf(member), prodId, w.id)).toBe(false);
    await shareTo(prodId, w.id, member);
    expect(await canViewWiki(actorOf(member), prodId, w.id)).toBe(true);
    expect(await canEnumerateWiki(actorOf(member), prodId, w.id)).toBe(true);
  });
});

describe("routes", () => {
  const cookieFor = (userId: string, isAdmin = false) =>
    `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin })}`;
  function makeReq(method: string, url: string, userId: string, isAdmin = false, body?: unknown) {
    return new NextRequest(`http://localhost${url}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookieFor(userId, isAdmin) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  const ctx = () => ({ params: Promise.resolve({ id: prodId }) });

  it("搜索走内容面，不是枚举面（否则反复搜即枚举）", async () => {
    const w = await createWiki({
      productionId: prodId, title: "搜索面判据文档", createdBy: creator, listable: false });
    await setWikiPublic(w.id, prodId, true);   // 可读、不可枚举

    const tree = await wikiListGET(makeReq("GET", `/api/production/${prodId}/wiki`, member), ctx());
    const treeIds = ((await tree.json()).wikis as { id: string }[]).map(x => x.id);
    expect(treeIds).not.toContain(w.id);

    const hit = await wikiListGET(
      makeReq("GET", `/api/production/${prodId}/wiki?q=${encodeURIComponent("搜索面判据")}`, member), ctx());
    const hitIds = ((await hit.json()).results as { id: string }[]).map(x => x.id);
    expect(hitIds).toContain(w.id);   // 能读 ⇒ 能搜到

    // 反向：可枚举但不可读的，搜索里不出现
    const nameOnly = await createWiki({
      productionId: prodId, title: "搜索面判据私密", createdBy: creator });
    const hit2 = await wikiListGET(
      makeReq("GET", `/api/production/${prodId}/wiki?q=${encodeURIComponent("搜索面判据")}`, member), ctx());
    const hit2Ids = ((await hit2.json()).results as { id: string }[]).map(x => x.id);
    expect(hit2Ids).not.toContain(nameOnly.id);
  });

  it("落位门：不能建到/移到自己列不出的父下", async () => {
    const hidden = await createWiki({
      productionId: prodId, title: "落位门隐藏父", createdBy: creator, listable: false });
    const own = await createWiki({ productionId: prodId, title: "落位门自有文档", createdBy: member });

    expect(await canPlaceWikiUnder(actorOf(member), prodId, null)).toBe(true);
    expect(await canPlaceWikiUnder(actorOf(member), prodId, hidden.id)).toBe(false);

    const created = await wikiPOST(
      makeReq("POST", `/api/production/${prodId}/wiki`, member, false,
        { title: "不该落进去", parentId: hidden.id }), ctx());
    expect(created.status).toBe(403);

    const moved = await wikiPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki/${own.id}`, member, false,
        { parentId: hidden.id }),
      { params: Promise.resolve({ id: prodId, wikiId: own.id }) });
    expect(moved.status).toBe(403);
    expect((await getWiki(own.id, prodId))!.parentId).toBeNull();
  });

  it("容器写门：父的 *@edit 才能动它的子目录；只认直接父，不沿祖先链", async () => {
    // grandparent(member 有 edit) → parent(member 无 edit) → 目标位置
    const grand = await createWiki({ productionId: prodId, title: "容器门祖父", createdBy: creator });
    const parent = await createWiki({
      productionId: prodId, title: "容器门父", parentId: grand.id, createdBy: creator });
    await shareTo(prodId, grand.id, member, "edit");   // 只给祖父，不给父
    const own = await createWiki({ productionId: prodId, title: "容器门自有", createdBy: member });

    expect(await canWriteWikiContainer(actorOf(member), prodId, grand.id)).toBe(true);
    expect(await canWriteWikiContainer(actorOf(member), prodId, parent.id)).toBe(false);  // 不继承
    expect(await canWriteWikiContainer(actorOf(member), prodId, null)).toBe(true);        // 顶层无门

    const denied = await wikiPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki/${own.id}`, member, false,
        { parentId: parent.id }),
      { params: Promise.resolve({ id: prodId, wikiId: own.id }) });
    expect(denied.status).toBe(403);

    const ok = await wikiPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki/${own.id}`, member, false,
        { parentId: grand.id }),
      { params: Promise.resolve({ id: prodId, wikiId: own.id }) });
    expect(ok.status).toBe(200);
  });

  it("容器写门管源父：不能把文档从别人的子树里挪走", async () => {
    const theirFolder = await createWiki({ productionId: prodId, title: "别人的目录", createdBy: creator });
    const inside = await createWiki({
      productionId: prodId, title: "别人目录里的文档", parentId: theirFolder.id, createdBy: creator });
    await shareTo(prodId, inside.id, member, "edit");   // 对文档本身有 edit，对容器没有

    const yanked = await wikiPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki/${inside.id}`, member, false, { parentId: "" }),
      { params: Promise.resolve({ id: prodId, wikiId: inside.id }) });
    expect(yanked.status).toBe(403);
    expect((await getWiki(inside.id, prodId))!.parentId).toBe(theirFolder.id);
  });

  it("系统锚点豁免容器写门（否则默认树谁都放不进东西）", async () => {
    const anchorId = await ensureDramaturgyRootAnchor(prodId);
    expect(anchorId).toBeTruthy();
    // 锚点是 INSERT 直建的：无 created_by、无任何 edit 行
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM production_member_grant
       WHERE resource_type = 'wiki' AND resource_id = $1 AND permission_level = 'edit' AND NOT is_revoked`,
      [anchorId]);
    expect(Number(rows[0].n)).toBe(0);
    expect(await isWikiAnchor(anchorId!)).toBe(true);
    expect(await canWriteWikiContainer(actorOf(member), prodId, anchorId)).toBe(true);
  });

  it("创建与移动同门：无权移入时不能改为在目标父下新建", async () => {
    const theirFolder = await createWiki({ productionId: prodId, title: "创建门目录", createdBy: creator });
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'wiki', '*', '*', 'create', 'direct', $2)`,
      [prodId, member]);
    const res = await wikiPOST(
      makeReq("POST", `/api/production/${prodId}/wiki`, member, false,
        { title: "后门文档", parentId: theirFolder.id }), ctx());
    expect(res.status).toBe(403);
  });

  // #333 不变量 2：工具端实时判定是唯一安全边界——REST 装了门 AI 通道没装
  // 就是一条旁路（"让 AI 帮我挪进别人的目录"）。
  it("AI 工具面与 REST 逐条同源：propose_create / propose_move 同样过落位双门", async () => {
    const theirFolder = await createWiki({ productionId: prodId, title: "AI 通道目录", createdBy: creator });
    const inside = await createWiki({
      productionId: prodId, title: "AI 通道目录里的文档", parentId: theirFolder.id, createdBy: creator });
    await shareTo(prodId, inside.id, member, "edit");
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'wiki', '*', '*', 'create', 'direct', $2) ON CONFLICT DO NOTHING`,
      [prodId, member]);

    const created = await wikiProposeCreate(member, prodId, `tc-${Date.now()}-a`,
      { parentId: theirFolder.id, title: "AI 后门文档", summary: "" });
    expect(created).toContain("权限被拒绝");

    const moved = await wikiProposeMove(member, prodId, `tc-${Date.now()}-b`,
      { wikiId: inside.id, newParentId: null, summary: "" });
    expect(moved).toContain("权限被拒绝");
    expect((await getWiki(inside.id, prodId))!.parentId).toBe(theirFolder.id);
  });

  it("排序键由服务端在完整兄弟集上算（残缺兄弟集不再影响落位）", async () => {
    const parent = await createWiki({ productionId: prodId, title: "排序父", createdBy: creator });
    const a = await createWiki({ productionId: prodId, title: "兄A", parentId: parent.id, createdBy: creator });
    const hiddenB = await createWiki({
      productionId: prodId, title: "兄B隐", parentId: parent.id, createdBy: creator, listable: false });
    const c = await createWiki({ productionId: prodId, title: "兄C", parentId: parent.id, createdBy: creator });
    const mover = await createWiki({ productionId: prodId, title: "被拖的", createdBy: creator });

    // member 眼里兄弟集是 [A, C]（B 隐身）。他拖到「C 之前」——服务端必须把键
    // 落在 B 与 C 之间，而不是 A 与 C 之间（后者会与看不见的 B 交错）。
    await updateWiki(mover.id, prodId,
      { parentId: parent.id, place: { anchorId: c.id, side: "before" } }, creator);

    const sibs = (await listWikiLibrary(prodId))
      .filter(w => w.parentId === parent.id)
      .sort((x, y) => (x.sortKey ?? "").localeCompare(y.sortKey ?? ""));
    expect(sibs.map(w => w.id)).toEqual([a.id, hiddenB.id, mover.id, c.id]);
  });

  it("PATCH listable 走分享面（grants@edit），不是编辑面", async () => {
    const w = await createWiki({ productionId: prodId, title: "分享面开关", createdBy: creator });
    // 只发 edit 档（*@edit，无 grants@edit）
    await shareTo(prodId, w.id, member, "edit");
    const denied = await wikiPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki/${w.id}`, member, false, { listable: false }),
      { params: Promise.resolve({ id: prodId, wikiId: w.id }) });
    expect(denied.status).toBe(403);
    expect((await getWiki(w.id, prodId))!.listable).toBe(true);

    // 创建者持 manage 档（含 grants@edit）
    const ok = await wikiPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki/${w.id}`, creator, false, { listable: false }),
      { params: Promise.resolve({ id: prodId, wikiId: w.id }) });
    expect(ok.status).toBe(200);
    expect((await getWiki(w.id, prodId))!.listable).toBe(false);
  });
});
