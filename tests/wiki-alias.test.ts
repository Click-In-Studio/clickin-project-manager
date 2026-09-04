import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { createWiki, deleteWiki, getWiki, updateWiki } from "@/lib/wiki/content";
import {
  createNodeLink, moveNodeLink, renameNodeLink, filterEnumerableLinkEntries,
} from "@/lib/node/link";
import {
  getNode, deleteNode, listNodeLibrary, setNodePublic, moveNode, insertNode, newNodeId,
} from "@/lib/node/db";
import { canViewWiki } from "@/lib/wiki/perm";
import { listEnumerableNodeIds } from "@/lib/node/perm";
import { listNodeTreeFor } from "@/lib/node/tree-view";
import { WIKI_LEVEL_ROW_SETS } from "@/lib/resource-grant-db";
import { POST as aliasPOST } from "@/app/api/production/[id]/wiki-alias/route";
import { PATCH as aliasPATCH, DELETE as aliasDELETE } from "@/app/api/production/[id]/wiki-alias/[aliasId]/route";
import { makeProduction, cleanupProduction } from "./factories";

// #358 软链接 → #420 kind='link' 节点。判定式逐字延续：
//   可枚举(u, link) ⟺ 可枚举(u, link 的父) ∧ **本地**可枚举(u, 目标)
//   读内容        ⟺ 目标自己的内容门     ← link 一票不投
// 第二合取项取本地口径（不含目标自己的祖先链）是 #358 的拍板点，「提出私密
// 子树」那条就是它的证人：换成全可枚举口径，那条会红。

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
async function grantCreate(prodId: string, userId: string) {
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, 'wiki', '*', '*', 'create', 'direct', $2)
     ON CONFLICT DO NOTHING`,
    [prodId, userId]);
}

/** 判定式全式经树取数口：目录树里该用户看不看得到这个 link。 */
async function canSee(userId: string, prodId: string, linkNodeId: string): Promise<boolean> {
  const actor = actorOf(userId);
  const enumerable = await listEnumerableNodeIds(actor, prodId);
  const links = (await listNodeLibrary(prodId)).filter(n => n.kind === "link");
  const list = await filterEnumerableLinkEntries(actor, prodId, links, enumerable);
  return list.some(l => l.id === linkNodeId);
}

async function seen(userId: string, prodId: string, linkNodeId: string) {
  const actor = actorOf(userId);
  const enumerable = await listEnumerableNodeIds(actor, prodId);
  const links = (await listNodeLibrary(prodId)).filter(n => n.kind === "link");
  const list = await filterEnumerableLinkEntries(actor, prodId, links, enumerable);
  return list.find(l => l.id === linkNodeId);
}

let prodId: string;
let creator: string;
let member: string;
const users: string[] = [];

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  creator = await newMember(prodId);
  member = await newMember(prodId);
  users.push(creator, member);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1)", [users]).catch(() => {});
});

describe("schema：link 不是授权面", () => {
  it("kind='link' 的权限位被 CHECK 钉死（原「无权限列」物理保证的新形态）", async () => {
    const doc = await createWiki({ productionId: prodId, title: "物理保证目标", createdBy: creator });
    // 试图造一个 listable=false 的 link（权限洗白通道）→ 约束当场拒绝
    await expect(getPool().query(
      `INSERT INTO node (id, production_id, kind, link_target_id, listable)
       VALUES ($1, $2, 'link', $3, false)`,
      [newNodeId(), prodId, doc.nodeId],
    )).rejects.toThrow(/node_link_no_perm_check/);
    await expect(getPool().query(
      `INSERT INTO node (id, production_id, kind, link_target_id, is_public)
       VALUES ($1, $2, 'link', $3, true)`,
      [newNodeId(), prodId, doc.nodeId],
    )).rejects.toThrow(/node_link_no_perm_check/);
  });

  it("同一容器下同一目标只允许一个 link", async () => {
    const box = await createWiki({ productionId: prodId, title: "唯一约束容器", createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "唯一约束目标", createdBy: creator });
    const first = await createNodeLink({
      productionId: prodId, parentId: box.nodeId, targetNodeId: doc.nodeId, createdBy: creator });
    expect(first.ok).toBe(true);
    const second = await createNodeLink({
      productionId: prodId, parentId: box.nodeId, targetNodeId: doc.nodeId, createdBy: creator });
    expect(second).toEqual({ ok: false, reason: "duplicate" });
  });
});

describe("判定式", () => {
  it("本地口径：目标埋在不可枚举的子树里，link 照样把它提到公开位置", async () => {
    const vault = await createWiki({
      productionId: prodId, title: "提出私密子树·私密容器", createdBy: creator, listable: false });
    const doc = await createWiki({
      productionId: prodId, title: "提出私密子树·目标", parentNodeId: vault.nodeId, createdBy: creator });
    const shelf = await createWiki({ productionId: prodId, title: "提出私密子树·公开容器", createdBy: creator });

    // 目标在原位置对 member 不可枚举（祖先链被私密容器挡着）
    const e = await listEnumerableNodeIds(actorOf(member), prodId);
    expect(e.ids.has(doc.nodeId)).toBe(false);

    const res = await createNodeLink({
      productionId: prodId, parentId: shelf.nodeId, targetNodeId: doc.nodeId, createdBy: creator });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // ← #358 拍板点：取全可枚举口径这里会是 false，软链接主用途当场失效
    expect(await canSee(member, prodId, res.link.id)).toBe(true);
  });

  it("节点自身属性一分不放：目标 listable=false ⇒ link 不可枚举", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "本地否决·容器", createdBy: creator });
    const doc = await createWiki({
      productionId: prodId, title: "本地否决·目标", createdBy: creator, listable: false });
    const res = await createNodeLink({
      productionId: prodId, parentId: shelf.nodeId, targetNodeId: doc.nodeId, createdBy: creator });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await canSee(member, prodId, res.link.id)).toBe(false);
    // 被显式分享者（meta@view 行，内容域键）拿得回来——本地可枚举的第二个通道
    await shareTo(prodId, doc.id, member);
    expect(await canSee(member, prodId, res.link.id)).toBe(true);
  });

  it("位置维：link 的父不可枚举 ⇒ link 不可枚举（E(子) ⊆ E(父) 对 link 照样成立）", async () => {
    const hiddenBox = await createWiki({
      productionId: prodId, title: "位置维·隐藏容器", createdBy: creator, listable: false });
    const doc = await createWiki({ productionId: prodId, title: "位置维·目标", createdBy: creator });
    const res = await createNodeLink({
      productionId: prodId, parentId: hiddenBox.nodeId, targetNodeId: doc.nodeId, createdBy: creator });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await canSee(member, prodId, res.link.id)).toBe(false);
  });

  it("link 不改内容可见性：树里看得到标题，读正文仍走目标自己的门", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "内容面·容器", createdBy: creator });
    const secret = await createWiki({ productionId: prodId, title: "内容面·私密目标", createdBy: creator });
    const res = await createNodeLink({
      productionId: prodId, parentId: shelf.nodeId, targetNodeId: secret.nodeId, createdBy: creator });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(await canSee(member, prodId, res.link.id)).toBe(true);      // 目录级信息流出
    expect(await canViewWiki(actorOf(member), prodId, secret.id)).toBe(false);  // 内容仍关着

    // 建 link 不发任何 grant 行（§0.9 负面清单：结构面永不物化）
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM production_member_grant
       WHERE production_id = $1 AND resource_type = 'wiki' AND resource_id = $2 AND user_id = $3`,
      [prodId, secret.id, member]);
    expect(Number(rows[0].n)).toBe(0);
  });

  it("目标标题实时取自目标（缺省无自有标题，不会分叉）", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "标题·容器", createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "改名前", createdBy: creator });
    await setNodePublic(doc.nodeId, prodId, true);
    const res = await createNodeLink({
      productionId: prodId, parentId: shelf.nodeId, targetNodeId: doc.nodeId, createdBy: creator });
    if (!res.ok) throw new Error("建链接失败");
    await updateWiki(doc.id, prodId, { title: "改名后" }, creator);
    expect((await seen(member, prodId, res.link.id))?.displayTitle).toBe("改名后");
  });
});

describe("显示名（#358 ⑤）", () => {
  /** 造一个 member 看得见的 link。 */
  async function visibleLink(label: string, displayTitle?: string) {
    const shelf = await createWiki({ productionId: prodId, title: `${label}·容器`, createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: `${label}·目标`, createdBy: creator });
    const res = await createNodeLink({
      productionId: prodId, parentId: shelf.nodeId, targetNodeId: doc.nodeId,
      createdBy: creator, ...(displayTitle !== undefined ? { displayTitle } : {}),
    });
    if (!res.ok) throw new Error("建链接失败");
    return { linkId: res.link.id, docId: doc.id, docNodeId: doc.nodeId, shelfId: shelf.nodeId };
  }

  it("缺省跟随目标；给了显示名就用显示名，目标标题另行给出", async () => {
    const auto = await visibleLink("显示名·跟随");
    expect((await seen(member, prodId, auto.linkId))?.displayTitle).toBe("显示名·跟随·目标");
    expect((await seen(member, prodId, auto.linkId))?.title).toBeNull();  // 无自有覆盖

    const named = await visibleLink("显示名·自有", "灵感库里的叫法");
    const row = await seen(member, prodId, named.linkId);
    expect(row?.displayTitle).toBe("灵感库里的叫法");
    expect(row?.targetTitle).toBe("显示名·自有·目标");   // UI 要能说清指向谁
  });

  it("显示名是这个位置的标签：目标标题、其他位置都不受影响", async () => {
    const { linkId, docId, docNodeId } = await visibleLink("显示名·隔离");
    const other = await createWiki({ productionId: prodId, title: "显示名·另一个容器", createdBy: creator });
    const second = await createNodeLink({
      productionId: prodId, parentId: other.nodeId, targetNodeId: docNodeId, createdBy: creator });
    if (!second.ok) throw new Error("建链接失败");

    await renameNodeLink(linkId, prodId, "只在这里改名");
    expect((await getWiki(docId, prodId))!.title).toBe("显示名·隔离·目标");   // 目标没动
    expect((await seen(member, prodId, second.link.id))?.displayTitle).toBe("显示名·隔离·目标");
  });

  it("空白＝改回跟随目标（不留看不见的空串）", async () => {
    const { linkId } = await visibleLink("显示名·清空", "临时叫法");
    expect((await renameNodeLink(linkId, prodId, "   "))?.title).toBeNull();
    expect((await seen(member, prodId, linkId))?.displayTitle).toBe("显示名·清空·目标");
  });

  it("改了显示名之后，目标改名不再影响这个位置（分叉是显式选的）", async () => {
    const { linkId, docId } = await visibleLink("显示名·分叉", "固定叫法");
    await updateWiki(docId, prodId, { title: "目标改名了" }, creator);
    const row = await seen(member, prodId, linkId);
    expect(row?.displayTitle).toBe("固定叫法");
    expect(row?.targetTitle).toBe("目标改名了");
  });

  it("显示名不参与判定：改名不让不可枚举的目标冒出来", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "显示名·判定容器", createdBy: creator });
    const doc = await createWiki({
      productionId: prodId, title: "显示名·判定目标", createdBy: creator, listable: false });
    const res = await createNodeLink({
      productionId: prodId, parentId: shelf.nodeId, targetNodeId: doc.nodeId,
      createdBy: creator, displayTitle: "起个好听的名字" });
    if (!res.ok) throw new Error("建链接失败");
    expect(await canSee(member, prodId, res.link.id)).toBe(false);
  });
});

describe("结构：叶子 / 无链式 / 不入目标子树", () => {
  it("link 是叶子：不能作为父（新建子文档时父不合法）", async () => {
    const doc = await createWiki({ productionId: prodId, title: "叶子·目标", createdBy: creator });
    const res = await createNodeLink({
      productionId: prodId, parentId: null, targetNodeId: doc.nodeId, createdBy: creator });
    if (!res.ok) throw new Error("建链接失败");
    await expect(createWiki({
      productionId: prodId, title: "挂在链接下", parentNodeId: res.link.id, createdBy: creator,
    })).rejects.toThrow();
  });

  it("链式 link 不可表达：目标不能是 link（#420 建时即拒）", async () => {
    const doc = await createWiki({ productionId: prodId, title: "链式·目标", createdBy: creator });
    const first = await createNodeLink({
      productionId: prodId, parentId: null, targetNodeId: doc.nodeId, createdBy: creator });
    if (!first.ok) throw new Error("建链接失败");
    const chained = await createNodeLink({
      productionId: prodId, parentId: null, targetNodeId: first.link.id, createdBy: creator });
    expect(chained).toEqual({ ok: false, reason: "unsupported_target" });
  });

  it("folder 目标本批不支持（「链一棵子树」待议）", async () => {
    // 资产根是现成的 folder 节点
    const { ensureAssetsRootAnchor } = await import("@/lib/node/anchors");
    const folderId = await ensureAssetsRootAnchor(prodId);
    const res = await createNodeLink({
      productionId: prodId, parentId: null, targetNodeId: folderId, createdBy: creator });
    expect(res).toEqual({ ok: false, reason: "unsupported_target" });
  });

  it("不得建/移进目标自己的子树（含目标本身）", async () => {
    const target = await createWiki({ productionId: prodId, title: "自环·目标", createdBy: creator });
    const child = await createWiki({
      productionId: prodId, title: "自环·目标的子", parentNodeId: target.nodeId, createdBy: creator });
    expect(await createNodeLink({
      productionId: prodId, parentId: target.nodeId, targetNodeId: target.nodeId, createdBy: creator,
    })).toEqual({ ok: false, reason: "inside_target_subtree" });
    expect(await createNodeLink({
      productionId: prodId, parentId: child.nodeId, targetNodeId: target.nodeId, createdBy: creator,
    })).toEqual({ ok: false, reason: "inside_target_subtree" });

    const outside = await createWiki({ productionId: prodId, title: "自环·外部容器", createdBy: creator });
    const ok = await createNodeLink({
      productionId: prodId, parentId: outside.nodeId, targetNodeId: target.nodeId, createdBy: creator });
    if (!ok.ok) throw new Error("建链接失败");
    expect(await moveNodeLink(ok.link.id, prodId, { parentId: child.nodeId }))
      .toEqual({ ok: false, reason: "inside_target_subtree" });
  });
});

describe("排序：与真实兄弟共用一把尺", () => {
  it("link 参与同层排序，服务端在单表全兄弟集上取键", async () => {
    const box = await createWiki({ productionId: prodId, title: "排序·容器", createdBy: creator });
    const a = await createWiki({ productionId: prodId, title: "排序·真A", parentNodeId: box.nodeId, createdBy: creator });
    const target = await createWiki({ productionId: prodId, title: "排序·目标", createdBy: creator });
    const link = await createNodeLink({
      productionId: prodId, parentId: box.nodeId, targetNodeId: target.nodeId, createdBy: creator });
    if (!link.ok) throw new Error("建链接失败");
    // 真B 插在 link 之前——锚点是 link，键必须在含 link 的兄弟集上算
    const b = await createWiki({ productionId: prodId, title: "排序·真B", parentNodeId: box.nodeId, createdBy: creator });
    await moveNode(b.nodeId, prodId, { place: { anchorId: link.link.id, side: "before" } });

    const rows = await getPool().query<{ id: string }>(
      `SELECT id FROM node WHERE parent_id = $1 ORDER BY sort_key`, [box.nodeId]);
    expect(rows.rows.map(r => r.id)).toEqual([a.nodeId, b.nodeId, link.link.id]);
  });
});

describe("生命周期", () => {
  it("目标被删 → 指向它的 link 随 FK 级联消失", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "级联·容器", createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "级联·目标", createdBy: creator });
    const res = await createNodeLink({
      productionId: prodId, parentId: shelf.nodeId, targetNodeId: doc.nodeId, createdBy: creator });
    if (!res.ok) throw new Error("建链接失败");
    expect(await deleteWiki(doc.id, prodId)).toEqual({ ok: true });
    expect(await getNode(res.link.id, prodId)).toBeNull();
  });

  it("link 的父被删 → link 与子文档一样上移一层，不掉顶层", async () => {
    const grand = await createWiki({ productionId: prodId, title: "上移·祖父", createdBy: creator });
    const parent = await createWiki({
      productionId: prodId, title: "上移·父", parentNodeId: grand.nodeId, createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "上移·目标", createdBy: creator });
    const res = await createNodeLink({
      productionId: prodId, parentId: parent.nodeId, targetNodeId: doc.nodeId, createdBy: creator });
    if (!res.ok) throw new Error("建链接失败");
    expect(await deleteWiki(parent.id, prodId)).toEqual({ ok: true });
    expect((await getNode(res.link.id, prodId))?.parentId).toBe(grand.nodeId);
  });

  it("删 link 只删一个位置，目标一动不动", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "删链接·容器", createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "删链接·目标", createdBy: creator });
    const res = await createNodeLink({
      productionId: prodId, parentId: shelf.nodeId, targetNodeId: doc.nodeId, createdBy: creator });
    if (!res.ok) throw new Error("建链接失败");
    expect(await deleteNode(res.link.id, prodId)).toEqual({ ok: true });
    expect(await getWiki(doc.id, prodId)).not.toBeNull();
  });

  it("目标被移走，link 不受影响（认 id 不认位置）", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "移走·容器", createdBy: creator });
    const elsewhere = await createWiki({ productionId: prodId, title: "移走·别处", createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "移走·目标", createdBy: creator });
    const res = await createNodeLink({
      productionId: prodId, parentId: shelf.nodeId, targetNodeId: doc.nodeId, createdBy: creator });
    if (!res.ok) throw new Error("建链接失败");
    await moveNode(doc.nodeId, prodId, { parentId: elsewhere.nodeId });
    expect((await getNode(res.link.id, prodId))?.parentId).toBe(shelf.nodeId);
    expect(await canSee(member, prodId, res.link.id)).toBe(true);
  });
});

describe("routes", () => {
  const cookieFor = (userId: string, isAdmin = false) =>
    `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin })}`;
  function makeReq(method: string, url: string, userId: string, body?: unknown) {
    return new NextRequest(`http://localhost${url}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookieFor(userId) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  const ctx = () => ({ params: Promise.resolve({ id: prodId }) });
  const aliasCtx = (aliasId: string) => ({ params: Promise.resolve({ id: prodId, aliasId }) });

  it("建链接要 wiki/*@create（与建文档同门，否则是条后门）", async () => {
    const doc = await createWiki({ productionId: prodId, title: "门·create 目标", createdBy: creator });
    await setNodePublic(doc.nodeId, prodId, true);
    const nobody = await newMember(prodId);
    users.push(nobody);
    const denied = await aliasPOST(
      makeReq("POST", `/api/production/${prodId}/wiki-alias`, nobody, { targetNodeId: doc.nodeId }), ctx());
    expect(denied.status).toBe(403);
  });

  it("落位双门 + 目标可达门（targetNodeId 首选、旧 targetId=wiki uuid 兼容）", async () => {
    await grantCreate(prodId, member);
    const theirBox = await createWiki({ productionId: prodId, title: "门·别人的容器", createdBy: creator });
    const openDoc = await createWiki({ productionId: prodId, title: "门·公开目标", createdBy: creator });
    await setNodePublic(openDoc.nodeId, prodId, true);

    // ② 容器写门：对 theirBox 没有 *@edit
    const noContainer = await aliasPOST(
      makeReq("POST", `/api/production/${prodId}/wiki-alias`, member,
        { parentId: theirBox.nodeId, targetNodeId: openDoc.nodeId }), ctx());
    expect(noContainer.status).toBe(403);

    // ③ 目标可达门：既不可枚举也不可读的目标
    const hiddenBox = await createWiki({
      productionId: prodId, title: "门·隐藏容器", createdBy: creator, listable: false });
    const unreachable = await createWiki({
      productionId: prodId, title: "门·够不着的目标", parentNodeId: hiddenBox.nodeId, createdBy: creator });
    const noTarget = await aliasPOST(
      makeReq("POST", `/api/production/${prodId}/wiki-alias`, member,
        { parentId: null, targetNodeId: unreachable.nodeId }), ctx());
    expect(noTarget.status).toBe(403);

    // 顶层 + 可达目标（旧口径 targetId=wiki uuid 走兼容翻译）：通
    const ok = await aliasPOST(
      makeReq("POST", `/api/production/${prodId}/wiki-alias`, member,
        { parentId: null, targetId: openDoc.id }), ctx());
    expect(ok.status).toBe(201);
    const created = (await ok.json()).alias as { id: string };
    expect(created.id.startsWith("nd_")).toBe(true);

    // 移 link **不需要**目标的 edit 权：位置面的事，与那篇文档无关
    const myBox = await createWiki({ productionId: prodId, title: "门·自己的容器", createdBy: member });
    const moved = await aliasPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki-alias/${created.id}`, member,
        { parentId: myBox.nodeId }), aliasCtx(created.id));
    expect(moved.status).toBe(200);
    expect((await getNode(created.id, prodId))?.parentId).toBe(myBox.nodeId);

    const gone = await aliasDELETE(
      makeReq("DELETE", `/api/production/${prodId}/wiki-alias/${created.id}`, member), aliasCtx(created.id));
    expect(gone.status).toBe(200);
  });

  it("改显示名走自己那道门：创建者能给自己放在别人容器里的位置改名，但挪不走", async () => {
    await grantCreate(prodId, member);
    const theirBox = await createWiki({ productionId: prodId, title: "改名门·别人的容器", createdBy: creator });
    await setNodePublic(theirBox.nodeId, prodId, true);
    await shareTo(prodId, theirBox.id, member, "edit");
    const doc = await createWiki({ productionId: prodId, title: "改名门·目标", createdBy: creator });
    await setNodePublic(doc.nodeId, prodId, true);
    const created = await aliasPOST(
      makeReq("POST", `/api/production/${prodId}/wiki-alias`, member,
        { parentId: theirBox.nodeId, targetNodeId: doc.nodeId }), ctx());
    expect(created.status).toBe(201);
    const alias = (await created.json()).alias as { id: string };

    // 收回容器写权：此后 member 只剩「我是这个链接的创建者」这一条通道
    await getPool().query(
      `UPDATE production_member_grant SET is_revoked = true
       WHERE production_id = $1 AND user_id = $2 AND resource_type = 'wiki' AND resource_id = $3`,
      [prodId, member, theirBox.id]);

    const renamed = await aliasPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki-alias/${alias.id}`, member,
        { displayTitle: "我的叫法" }), aliasCtx(alias.id));
    expect(renamed.status).toBe(200);
    expect((await getNode(alias.id, prodId))?.title).toBe("我的叫法");
    // 目标标题一个字节没动
    expect((await getWiki(doc.id, prodId))!.title).toBe("改名门·目标");

    // 但位置面照旧关着：改标签 ≠ 有权把这个位置挪走（两道门刻意分家）
    const moved = await aliasPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki-alias/${alias.id}`, member,
        { parentId: "" }), aliasCtx(alias.id));
    expect(moved.status).toBe(403);
    expect((await getNode(alias.id, prodId))?.parentId).toBe(theirBox.nodeId);
  });

  it("与自己无关的人改不了显示名（容器写门 ∨ 创建者，都不满足）", async () => {
    const outsider = await newMember(prodId);
    users.push(outsider);
    const box = await createWiki({ productionId: prodId, title: "改名门·私有容器", createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "改名门·私有目标", createdBy: creator });
    const res = await createNodeLink({
      productionId: prodId, parentId: box.nodeId, targetNodeId: doc.nodeId, createdBy: creator });
    if (!res.ok) throw new Error("建链接失败");
    const denied = await aliasPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki-alias/${res.link.id}`, outsider,
        { displayTitle: "乱改" }), aliasCtx(res.link.id));
    expect(denied.status).toBe(403);
    expect((await getNode(res.link.id, prodId))?.title).toBeNull();
  });

  it("不支持的目标（link 节点）在路由层就 400", async () => {
    await grantCreate(prodId, member);
    const doc = await createWiki({ productionId: prodId, title: "不支持目标·文档", createdBy: creator });
    await setNodePublic(doc.nodeId, prodId, true);
    const first = await createNodeLink({
      productionId: prodId, parentId: null, targetNodeId: doc.nodeId, createdBy: creator });
    if (!first.ok) throw new Error("建链接失败");
    const res = await aliasPOST(
      makeReq("POST", `/api/production/${prodId}/wiki-alias`, member,
        { targetNodeId: first.link.id }), ctx());
    expect(res.status).toBe(400);
  });

  it("畸形入参不打 500：非字符串 id / 形状不对的 place 一律当没给", async () => {
    await grantCreate(prodId, member);
    const doc = await createWiki({ productionId: prodId, title: "畸形入参·目标", createdBy: creator });
    await setNodePublic(doc.nodeId, prodId, true);
    const res = await aliasPOST(
      makeReq("POST", `/api/production/${prodId}/wiki-alias`, member,
        { parentId: 12345, targetNodeId: doc.nodeId, place: "随便什么" }), ctx());
    expect(res.status).toBe(201);   // 落到顶层、尾部，而不是 TypeError → 500
    const alias = (await res.json()).alias as { id: string; parentId: string | null };
    expect(alias.parentId).toBeNull();

    const patched = await aliasPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki-alias/${alias.id}`, member,
        { place: { anchorId: 7, side: "sideways" } }), aliasCtx(alias.id));
    expect(patched.status).toBe(200);
  });

  it("容器写门管源父：不能把链接从别人的容器里挪走", async () => {
    await grantCreate(prodId, member);
    const theirBox = await createWiki({ productionId: prodId, title: "源父门·别人的容器", createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "源父门·目标", createdBy: creator });
    const res = await createNodeLink({
      productionId: prodId, parentId: theirBox.nodeId, targetNodeId: doc.nodeId, createdBy: creator });
    if (!res.ok) throw new Error("建链接失败");
    const yanked = await aliasPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki-alias/${res.link.id}`, member, { parentId: "" }),
      aliasCtx(res.link.id));
    expect(yanked.status).toBe(403);
    expect((await getNode(res.link.id, prodId))?.parentId).toBe(theirBox.nodeId);
  });

  it("树取数口把 link 一起给出来（listNodeTreeFor 单数组）", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "取数口·容器", createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "取数口·目标", createdBy: creator });
    const res = await createNodeLink({
      productionId: prodId, parentId: shelf.nodeId, targetNodeId: doc.nodeId, createdBy: creator });
    if (!res.ok) throw new Error("建链接失败");
    const tree = await listNodeTreeFor(actorOf(member), prodId);
    const entry = tree.nodes.find(n => n.id === res.link.id);
    expect(entry?.kind).toBe("link");
    // 同一个 id 不会再以别的 kind 出现
    expect(tree.nodes.filter(n => n.id === res.link.id)).toHaveLength(1);
  });
});
