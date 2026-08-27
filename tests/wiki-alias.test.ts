import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import {
  createWiki, deleteWiki, getWiki, setWikiPublic, updateWiki,
} from "@/lib/wiki-db";
import {
  createWikiAlias, deleteWikiAlias, getWikiAlias, isWikiAliasId,
  listEnumerableWikiAliases, moveWikiAlias, renameWikiAlias,
} from "@/lib/wiki-alias-db";
import { canViewWiki, listEnumerableWikiIds } from "@/lib/wiki-perm";
import { listWikiTreeFor } from "@/lib/wiki-tree";
import { WIKI_LEVEL_ROW_SETS } from "@/lib/resource-grant-db";
import { POST as aliasPOST } from "@/app/api/production/[id]/wiki-alias/route";
import { PATCH as aliasPATCH, DELETE as aliasDELETE } from "@/app/api/production/[id]/wiki-alias/[aliasId]/route";
import { makeProduction, cleanupProduction } from "./factories";

// #358 wiki 软链接。判定式：
//   可枚举(u, 别名) ⟺ 可枚举(u, 别名的父) ∧ **本地**可枚举(u, 目标)
//   读正文        ⟺ canViewWiki(u, 目标)     ← 别名一票不投
// 第二合取项取本地口径（不含目标自己的祖先链）是本 issue 的拍板点，下面「提出私密
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

/** 判定式全式：目录树里该用户看不看得到这个别名。 */
async function canSee(userId: string, prodId: string, aliasId: string): Promise<boolean> {
  const actor = actorOf(userId);
  const enumerable = await listEnumerableWikiIds(actor, prodId);
  const list = await listEnumerableWikiAliases(actor, prodId, enumerable);
  return list.some(a => a.id === aliasId);
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
  await getPool().query("DELETE FROM wiki_alias WHERE production_id = $1", [prodId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1)", [users]).catch(() => {});
});

describe("schema：别名不是授权面", () => {
  it("wiki_alias 表上没有任何授权列（listable / is_public）", async () => {
    const { rows } = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'wiki_alias'`);
    const cols = rows.map(r => r.column_name);
    expect(cols).toContain("target_id");
    // 这两列缺席即「建别名 → 设公开」这条权限洗白通道结构上不存在
    expect(cols).not.toContain("listable");
    expect(cols).not.toContain("is_public");
  });

  it("同一容器下同一目标只允许一个别名", async () => {
    const box = await createWiki({ productionId: prodId, title: "唯一约束容器", createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "唯一约束目标", createdBy: creator });
    const first = await createWikiAlias({
      productionId: prodId, parentId: box.id, targetType: "wiki", targetId: doc.id, createdBy: creator });
    expect(first.ok).toBe(true);
    const second = await createWikiAlias({
      productionId: prodId, parentId: box.id, targetType: "wiki", targetId: doc.id, createdBy: creator });
    expect(second).toEqual({ ok: false, reason: "duplicate" });
  });
});

describe("判定式", () => {
  it("本地口径：目标埋在不可枚举的子树里，别名照样把它提到公开位置", async () => {
    // 私密容器（listable=false）→ 目标；别名建在公开容器下
    const vault = await createWiki({
      productionId: prodId, title: "提出私密子树·私密容器", createdBy: creator, listable: false });
    const doc = await createWiki({
      productionId: prodId, title: "提出私密子树·目标", parentId: vault.id, createdBy: creator });
    const shelf = await createWiki({ productionId: prodId, title: "提出私密子树·公开容器", createdBy: creator });

    // 目标在原位置对 member 不可枚举（祖先链被私密容器挡着）
    const e = await listEnumerableWikiIds(actorOf(member), prodId);
    expect(e.ids.has(doc.id)).toBe(false);

    const res = await createWikiAlias({
      productionId: prodId, parentId: shelf.id, targetType: "wiki", targetId: doc.id, createdBy: creator });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // ← 本 issue 的拍板点：取全可枚举口径这里会是 false，软链接主用途当场失效
    expect(await canSee(member, prodId, res.alias.id)).toBe(true);
  });

  it("节点自身属性一分不放：目标 listable=false ⇒ 别名不可枚举", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "本地否决·容器", createdBy: creator });
    const doc = await createWiki({
      productionId: prodId, title: "本地否决·目标", createdBy: creator, listable: false });
    const res = await createWikiAlias({
      productionId: prodId, parentId: shelf.id, targetType: "wiki", targetId: doc.id, createdBy: creator });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await canSee(member, prodId, res.alias.id)).toBe(false);
    // 被显式分享者（meta@view 行）拿得回来——本地可枚举的第二个通道
    await shareTo(prodId, doc.id, member);
    expect(await canSee(member, prodId, res.alias.id)).toBe(true);
  });

  it("位置维：别名的父不可枚举 ⇒ 别名不可枚举（E(子) ⊆ E(父) 对别名照样成立）", async () => {
    const hiddenBox = await createWiki({
      productionId: prodId, title: "位置维·隐藏容器", createdBy: creator, listable: false });
    const doc = await createWiki({ productionId: prodId, title: "位置维·目标", createdBy: creator });
    const res = await createWikiAlias({
      productionId: prodId, parentId: hiddenBox.id, targetType: "wiki", targetId: doc.id, createdBy: creator });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await canSee(member, prodId, res.alias.id)).toBe(false);
  });

  it("别名不改内容可见性：树里看得到标题，读正文仍走目标自己的门", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "内容面·容器", createdBy: creator });
    const secret = await createWiki({ productionId: prodId, title: "内容面·私密目标", createdBy: creator });
    const res = await createWikiAlias({
      productionId: prodId, parentId: shelf.id, targetType: "wiki", targetId: secret.id, createdBy: creator });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(await canSee(member, prodId, res.alias.id)).toBe(true);      // 目录级信息流出
    expect(await canViewWiki(actorOf(member), prodId, secret.id)).toBe(false);  // 内容仍关着

    // 建别名不发任何 grant 行（§0.9 负面清单：结构面永不物化）
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM production_member_grant
       WHERE production_id = $1 AND resource_type = 'wiki' AND resource_id = $2 AND user_id = $3`,
      [prodId, secret.id, member]);
    expect(Number(rows[0].n)).toBe(0);
  });

  it("目标标题实时取自目标（别名没有自有标题，不会分叉）", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "标题·容器", createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "改名前", createdBy: creator });
    await setWikiPublic(doc.id, prodId, true);
    const res = await createWikiAlias({
      productionId: prodId, parentId: shelf.id, targetType: "wiki", targetId: doc.id, createdBy: creator });
    if (!res.ok) throw new Error("建别名失败");
    await updateWiki(doc.id, prodId, { title: "改名后" }, creator);
    const actor = actorOf(member);
    const list = await listEnumerableWikiAliases(actor, prodId, await listEnumerableWikiIds(actor, prodId));
    expect(list.find(a => a.id === res.alias.id)?.title).toBe("改名后");
  });
});

describe("显示名（#358 ⑤）", () => {
  /** 造一个 member 看得见的别名，返回 [aliasId, 目标 id]。 */
  async function visibleAlias(label: string, displayTitle?: string) {
    const shelf = await createWiki({ productionId: prodId, title: `${label}·容器`, createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: `${label}·目标`, createdBy: creator });
    const res = await createWikiAlias({
      productionId: prodId, parentId: shelf.id, targetType: "wiki", targetId: doc.id,
      createdBy: creator, ...(displayTitle !== undefined ? { displayTitle } : {}),
    });
    if (!res.ok) throw new Error("建别名失败");
    return { aliasId: res.alias.id, docId: doc.id, shelfId: shelf.id };
  }
  async function seen(aliasId: string) {
    const actor = actorOf(member);
    const list = await listEnumerableWikiAliases(actor, prodId, await listEnumerableWikiIds(actor, prodId));
    return list.find(a => a.id === aliasId);
  }

  it("缺省跟随目标；给了显示名就用显示名，目标标题另行给出", async () => {
    const auto = await visibleAlias("显示名·跟随");
    expect((await seen(auto.aliasId))?.title).toBe("显示名·跟随·目标");
    expect((await seen(auto.aliasId))?.displayTitle).toBeNull();

    const named = await visibleAlias("显示名·自有", "灵感库里的叫法");
    const row = await seen(named.aliasId);
    expect(row?.title).toBe("灵感库里的叫法");
    expect(row?.targetTitle).toBe("显示名·自有·目标");   // UI 要能说清指向谁
  });

  it("显示名是这个位置的标签：目标标题、其他位置都不受影响", async () => {
    const { aliasId, docId, shelfId } = await visibleAlias("显示名·隔离");
    const other = await createWiki({ productionId: prodId, title: "显示名·另一个容器", createdBy: creator });
    const second = await createWikiAlias({
      productionId: prodId, parentId: other.id, targetType: "wiki", targetId: docId, createdBy: creator });
    if (!second.ok) throw new Error("建别名失败");

    await renameWikiAlias(aliasId, prodId, "只在这里改名");
    expect((await getWiki(docId, prodId))!.title).toBe("显示名·隔离·目标");   // 目标没动
    expect((await seen(second.alias.id))?.title).toBe("显示名·隔离·目标");   // 另一个位置没动
    expect(shelfId).toBeTruthy();
  });

  it("空白＝改回跟随目标（不留看不见的空串）", async () => {
    const { aliasId } = await visibleAlias("显示名·清空", "临时叫法");
    expect((await renameWikiAlias(aliasId, prodId, "   "))?.displayTitle).toBeNull();
    expect((await seen(aliasId))?.title).toBe("显示名·清空·目标");
  });

  it("改了显示名之后，目标改名不再影响这个位置（分叉是显式选的）", async () => {
    const { aliasId, docId } = await visibleAlias("显示名·分叉", "固定叫法");
    await updateWiki(docId, prodId, { title: "目标改名了" }, creator);
    const row = await seen(aliasId);
    expect(row?.title).toBe("固定叫法");
    expect(row?.targetTitle).toBe("目标改名了");
  });

  it("显示名不参与判定：改名不让不可枚举的目标冒出来", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "显示名·判定容器", createdBy: creator });
    const doc = await createWiki({
      productionId: prodId, title: "显示名·判定目标", createdBy: creator, listable: false });
    const res = await createWikiAlias({
      productionId: prodId, parentId: shelf.id, targetType: "wiki", targetId: doc.id,
      createdBy: creator, displayTitle: "起个好听的名字" });
    if (!res.ok) throw new Error("建别名失败");
    expect(await canSee(member, prodId, res.alias.id)).toBe(false);
  });
});

describe("结构：叶子 / 无链式 / 不入目标子树", () => {
  it("别名是叶子：不能作为父（新建子文档时父不存在）", async () => {
    const doc = await createWiki({ productionId: prodId, title: "叶子·目标", createdBy: creator });
    const res = await createWikiAlias({
      productionId: prodId, parentId: null, targetType: "wiki", targetId: doc.id, createdBy: creator });
    if (!res.ok) throw new Error("建别名失败");
    await expect(createWiki({
      productionId: prodId, title: "挂在别名下", parentId: res.alias.id, createdBy: creator,
    })).rejects.toThrow();
  });

  it("链式别名不可表达：目标只能是 wiki 行", async () => {
    const doc = await createWiki({ productionId: prodId, title: "链式·目标", createdBy: creator });
    const first = await createWikiAlias({
      productionId: prodId, parentId: null, targetType: "wiki", targetId: doc.id, createdBy: creator });
    if (!first.ok) throw new Error("建别名失败");
    const chained = await createWikiAlias({
      productionId: prodId, parentId: null, targetType: "wiki", targetId: first.alias.id, createdBy: creator });
    expect(chained).toEqual({ ok: false, reason: "target_not_found" });
  });

  it("不得建/移进目标自己的子树（含目标本身）", async () => {
    const target = await createWiki({ productionId: prodId, title: "自环·目标", createdBy: creator });
    const child = await createWiki({
      productionId: prodId, title: "自环·目标的子", parentId: target.id, createdBy: creator });
    expect(await createWikiAlias({
      productionId: prodId, parentId: target.id, targetType: "wiki", targetId: target.id, createdBy: creator,
    })).toEqual({ ok: false, reason: "inside_target_subtree" });
    expect(await createWikiAlias({
      productionId: prodId, parentId: child.id, targetType: "wiki", targetId: target.id, createdBy: creator,
    })).toEqual({ ok: false, reason: "inside_target_subtree" });

    const outside = await createWiki({ productionId: prodId, title: "自环·外部容器", createdBy: creator });
    const ok = await createWikiAlias({
      productionId: prodId, parentId: outside.id, targetType: "wiki", targetId: target.id, createdBy: creator });
    if (!ok.ok) throw new Error("建别名失败");
    expect(await moveWikiAlias(ok.alias.id, prodId, { parentId: child.id }))
      .toEqual({ ok: false, reason: "inside_target_subtree" });
  });

  it("未知 target_type 不出树（旧代码碰上新类型时静默丢弃，不误处理）", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "未知类型·容器", createdBy: creator });
    await setWikiPublic(shelf.id, prodId, true);
    await getPool().query(
      `INSERT INTO wiki_alias (id, production_id, parent_id, sort_key, target_type, target_id, created_by)
       VALUES ($1, $2, $3::uuid, 'a0', 'asset', 'ast_future', $4::uuid)`,
      ["wal_futuretype", prodId, shelf.id, creator]);
    expect(await canSee(member, prodId, "wal_futuretype")).toBe(false);
    expect(await createWikiAlias({
      productionId: prodId, parentId: shelf.id, targetType: "asset", targetId: "ast_x", createdBy: creator,
    })).toEqual({ ok: false, reason: "unsupported_target" });
  });
});

describe("排序：与真实兄弟共用一把尺", () => {
  it("别名参与同层排序，服务端在并集上取键", async () => {
    const box = await createWiki({ productionId: prodId, title: "排序·容器", createdBy: creator });
    const a = await createWiki({ productionId: prodId, title: "排序·真A", parentId: box.id, createdBy: creator });
    const target = await createWiki({ productionId: prodId, title: "排序·目标", createdBy: creator });
    const alias = await createWikiAlias({
      productionId: prodId, parentId: box.id, targetType: "wiki", targetId: target.id, createdBy: creator });
    if (!alias.ok) throw new Error("建别名失败");
    // 真B 插在别名之前——锚点是别名，键必须在含别名的兄弟集上算
    const b = await createWiki({ productionId: prodId, title: "排序·真B", parentId: box.id, createdBy: creator });
    await updateWiki(b.id, prodId, { place: { anchorId: alias.alias.id, side: "before" } }, creator);

    const rows = await getPool().query<{ id: string; sort_key: string }>(
      `SELECT id::text AS id, sort_key FROM wiki WHERE parent_id = $1::uuid
       UNION ALL SELECT id, sort_key FROM wiki_alias WHERE parent_id = $1::uuid
       ORDER BY sort_key`, [box.id]);
    expect(rows.rows.map(r => r.id)).toEqual([a.id, b.id, alias.alias.id]);
  });
});

describe("生命周期", () => {
  it("目标被删 → 指向它的别名一并消失", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "级联·容器", createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "级联·目标", createdBy: creator });
    const res = await createWikiAlias({
      productionId: prodId, parentId: shelf.id, targetType: "wiki", targetId: doc.id, createdBy: creator });
    if (!res.ok) throw new Error("建别名失败");
    expect(await deleteWiki(doc.id, prodId)).toEqual({ ok: true });
    expect(await getWikiAlias(res.alias.id, prodId)).toBeNull();
  });

  it("别名的父被删 → 别名与子文档一样上移一层，不掉顶层", async () => {
    const grand = await createWiki({ productionId: prodId, title: "上移·祖父", createdBy: creator });
    const parent = await createWiki({
      productionId: prodId, title: "上移·父", parentId: grand.id, createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "上移·目标", createdBy: creator });
    const res = await createWikiAlias({
      productionId: prodId, parentId: parent.id, targetType: "wiki", targetId: doc.id, createdBy: creator });
    if (!res.ok) throw new Error("建别名失败");
    expect(await deleteWiki(parent.id, prodId)).toEqual({ ok: true });
    expect((await getWikiAlias(res.alias.id, prodId))?.parentId).toBe(grand.id);
  });

  it("删别名只删一个位置，目标一动不动", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "删别名·容器", createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "删别名·目标", createdBy: creator });
    const res = await createWikiAlias({
      productionId: prodId, parentId: shelf.id, targetType: "wiki", targetId: doc.id, createdBy: creator });
    if (!res.ok) throw new Error("建别名失败");
    expect(await deleteWikiAlias(res.alias.id, prodId)).toBe(true);
    expect(await getWiki(doc.id, prodId)).not.toBeNull();
  });

  it("目标被移走，别名不受影响（认 id 不认位置）", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "移走·容器", createdBy: creator });
    const elsewhere = await createWiki({ productionId: prodId, title: "移走·别处", createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "移走·目标", createdBy: creator });
    const res = await createWikiAlias({
      productionId: prodId, parentId: shelf.id, targetType: "wiki", targetId: doc.id, createdBy: creator });
    if (!res.ok) throw new Error("建别名失败");
    await updateWiki(doc.id, prodId, { parentId: elsewhere.id }, creator);
    expect((await getWikiAlias(res.alias.id, prodId))?.parentId).toBe(shelf.id);
    expect(await canSee(member, prodId, res.alias.id)).toBe(true);
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

  it("建别名要 wiki/*@create（与建文档同门，否则是条后门）", async () => {
    const doc = await createWiki({ productionId: prodId, title: "门·create 目标", createdBy: creator });
    await setWikiPublic(doc.id, prodId, true);
    const nobody = await newMember(prodId);
    users.push(nobody);
    const denied = await aliasPOST(
      makeReq("POST", `/api/production/${prodId}/wiki-alias`, nobody, { targetId: doc.id }), ctx());
    expect(denied.status).toBe(403);
  });

  it("落位双门 + 目标可达门", async () => {
    await grantCreate(prodId, member);
    const theirBox = await createWiki({ productionId: prodId, title: "门·别人的容器", createdBy: creator });
    const openDoc = await createWiki({ productionId: prodId, title: "门·公开目标", createdBy: creator });
    await setWikiPublic(openDoc.id, prodId, true);

    // ② 容器写门：对 theirBox 没有 *@edit
    const noContainer = await aliasPOST(
      makeReq("POST", `/api/production/${prodId}/wiki-alias`, member,
        { parentId: theirBox.id, targetId: openDoc.id }), ctx());
    expect(noContainer.status).toBe(403);

    // ③ 目标可达门：既不可枚举也不可读的目标
    const hiddenBox = await createWiki({
      productionId: prodId, title: "门·隐藏容器", createdBy: creator, listable: false });
    const unreachable = await createWiki({
      productionId: prodId, title: "门·够不着的目标", parentId: hiddenBox.id, createdBy: creator });
    const noTarget = await aliasPOST(
      makeReq("POST", `/api/production/${prodId}/wiki-alias`, member,
        { parentId: null, targetId: unreachable.id }), ctx());
    expect(noTarget.status).toBe(403);

    // 顶层 + 可达目标：通
    const ok = await aliasPOST(
      makeReq("POST", `/api/production/${prodId}/wiki-alias`, member,
        { parentId: null, targetId: openDoc.id }), ctx());
    expect(ok.status).toBe(201);
    const created = (await ok.json()).alias as { id: string };
    expect(isWikiAliasId(created.id)).toBe(true);

    // 移别名**不需要**目标的 edit 权：位置面的事，与那篇文档无关
    const myBox = await createWiki({ productionId: prodId, title: "门·自己的容器", createdBy: member });
    const moved = await aliasPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki-alias/${created.id}`, member,
        { parentId: myBox.id }), aliasCtx(created.id));
    expect(moved.status).toBe(200);
    expect((await getWikiAlias(created.id, prodId))?.parentId).toBe(myBox.id);

    const gone = await aliasDELETE(
      makeReq("DELETE", `/api/production/${prodId}/wiki-alias/${created.id}`, member), aliasCtx(created.id));
    expect(gone.status).toBe(200);
  });

  it("改显示名走自己那道门：创建者能给自己放在别人容器里的位置改名，但挪不走", async () => {
    await grantCreate(prodId, member);
    const theirBox = await createWiki({ productionId: prodId, title: "改名门·别人的容器", createdBy: creator });
    await setWikiPublic(theirBox.id, prodId, true);
    // creator 给 member 容器写权，好让 member 能把别名放进去；随后收回不影响本条
    await shareTo(prodId, theirBox.id, member, "edit");
    const doc = await createWiki({ productionId: prodId, title: "改名门·目标", createdBy: creator });
    await setWikiPublic(doc.id, prodId, true);
    const created = await aliasPOST(
      makeReq("POST", `/api/production/${prodId}/wiki-alias`, member,
        { parentId: theirBox.id, targetId: doc.id }), ctx());
    expect(created.status).toBe(201);
    const alias = (await created.json()).alias as { id: string };

    // 收回容器写权：此后 member 只剩「我是这个别名的创建者」这一条通道
    await getPool().query(
      `UPDATE production_member_grant SET is_revoked = true
       WHERE production_id = $1 AND user_id = $2 AND resource_type = 'wiki' AND resource_id = $3`,
      [prodId, member, theirBox.id]);

    const renamed = await aliasPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki-alias/${alias.id}`, member,
        { displayTitle: "我的叫法" }), aliasCtx(alias.id));
    expect(renamed.status).toBe(200);
    expect((await getWikiAlias(alias.id, prodId))?.displayTitle).toBe("我的叫法");
    // 目标标题一个字节没动
    expect((await getWiki(doc.id, prodId))!.title).toBe("改名门·目标");

    // 但位置面照旧关着：改标签 ≠ 有权把这个位置挪走（两道门刻意分家）
    const moved = await aliasPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki-alias/${alias.id}`, member,
        { parentId: "" }), aliasCtx(alias.id));
    expect(moved.status).toBe(403);
    expect((await getWikiAlias(alias.id, prodId))?.parentId).toBe(theirBox.id);
  });

  it("与自己无关的人改不了显示名（容器写门 ∨ 创建者，都不满足）", async () => {
    const outsider = await newMember(prodId);
    users.push(outsider);
    const box = await createWiki({ productionId: prodId, title: "改名门·私有容器", createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "改名门·私有目标", createdBy: creator });
    const res = await createWikiAlias({
      productionId: prodId, parentId: box.id, targetType: "wiki", targetId: doc.id, createdBy: creator });
    if (!res.ok) throw new Error("建别名失败");
    const denied = await aliasPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki-alias/${res.alias.id}`, outsider,
        { displayTitle: "乱改" }), aliasCtx(res.alias.id));
    expect(denied.status).toBe(403);
    expect((await getWikiAlias(res.alias.id, prodId))?.displayTitle).toBeNull();
  });

  it("不支持的目标类型在路由层就 400（可达门挂解析器，不硬编码 target_type）", async () => {
    await grantCreate(prodId, member);
    const res = await aliasPOST(
      makeReq("POST", `/api/production/${prodId}/wiki-alias`, member,
        { targetType: "asset", targetId: "ast_whatever" }), ctx());
    expect(res.status).toBe(400);
  });

  it("畸形入参不打 500：非字符串 id / 形状不对的 place 一律当没给", async () => {
    await grantCreate(prodId, member);
    const doc = await createWiki({ productionId: prodId, title: "畸形入参·目标", createdBy: creator });
    await setWikiPublic(doc.id, prodId, true);
    const res = await aliasPOST(
      makeReq("POST", `/api/production/${prodId}/wiki-alias`, member,
        { parentId: 12345, targetId: doc.id, place: "随便什么" }), ctx());
    expect(res.status).toBe(201);   // 落到顶层、尾部，而不是 TypeError → 500
    const alias = (await res.json()).alias as { id: string; parentId: string | null };
    expect(alias.parentId).toBeNull();

    const patched = await aliasPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki-alias/${alias.id}`, member,
        { place: { anchorId: 7, side: "sideways" } }), aliasCtx(alias.id));
    expect(patched.status).toBe(200);
  });

  it("容器写门管源父：不能把别名从别人的容器里挪走", async () => {
    await grantCreate(prodId, member);
    const theirBox = await createWiki({ productionId: prodId, title: "源父门·别人的容器", createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "源父门·目标", createdBy: creator });
    const res = await createWikiAlias({
      productionId: prodId, parentId: theirBox.id, targetType: "wiki", targetId: doc.id, createdBy: creator });
    if (!res.ok) throw new Error("建别名失败");
    const yanked = await aliasPATCH(
      makeReq("PATCH", `/api/production/${prodId}/wiki-alias/${res.alias.id}`, member, { parentId: "" }),
      aliasCtx(res.alias.id));
    expect(yanked.status).toBe(403);
    expect((await getWikiAlias(res.alias.id, prodId))?.parentId).toBe(theirBox.id);
  });

  it("树取数口把别名一起给出来（listWikiTreeFor）", async () => {
    const shelf = await createWiki({ productionId: prodId, title: "取数口·容器", createdBy: creator });
    const doc = await createWiki({ productionId: prodId, title: "取数口·目标", createdBy: creator });
    const res = await createWikiAlias({
      productionId: prodId, parentId: shelf.id, targetType: "wiki", targetId: doc.id, createdBy: creator });
    if (!res.ok) throw new Error("建别名失败");
    const tree = await listWikiTreeFor(actorOf(member), prodId);
    expect(tree.aliases.some(a => a.id === res.alias.id)).toBe(true);
    expect(tree.wikis.some(w => w.id === res.alias.id)).toBe(false);   // 别名不混进文档集
  });
});
