import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { createWiki, getDramaturgyTreeConfig, listWikiLibrary, setWikiListable } from "@/lib/wiki-db";
import {
  listDramaturgyMoveInCandidates, listDramaturgyWikiAliases, listDramaturgyWikiSubtree,
} from "@/lib/dramaturgy-wiki";
import { listDramaturgyTreeFor } from "@/lib/wiki-tree";
import { readParentAnchor } from "@/lib/wiki-input";
import { resolveWikiAnchorParent } from "@/lib/wiki-placement";
import { WIKI_LEVEL_ROW_SETS } from "@/lib/resource-grant-db";
import { PATCH as wikiPATCH } from "@/app/api/production/[id]/wiki/[wikiId]/route";
import { POST as aliasPOST } from "@/app/api/production/[id]/wiki-alias/route";
import { makeProduction, cleanupProduction } from "./factories";
import type { WikiListEntry } from "@/lib/wiki-db";
import { canReachAliasTarget, type WikiAliasEntry } from "@/lib/wiki-alias-db";

// #355 灵感库「移入」。两种形态是同一个入口的两个选项：
//   本体移入 —— PATCH /wiki/<id> 改 parent_id
//   建链接   —— POST /wiki-alias 在灵感库里放一个指向它的伪节点（#358）
//
// 本文件测的是这个入口下面的两块地基：
//   ① 候选表（谁能被移入、能不能移本体）——前端灰化的镜像
//   ② parentAnchor 落位——灵感库根是懒建的，第一次移入时它还不存在。ensure 是写
//      事务，必须留在门后面，否则一个最终 403 的请求会凭空建出一篇根文档。

const idSet = (...ids: string[]) => ({ wildcard: false, ids: new Set(ids) });
const ALL = { wildcard: true, ids: new Set<string>() };

function entry(id: string, parentId: string | null, isAnchor = false): WikiListEntry {
  return { id, parentId, title: id, tags: [], sortKey: null, isAnchor } as unknown as WikiListEntry;
}
function aliasTo(targetId: string, parentId: string): WikiAliasEntry {
  return { id: `wal_${targetId}`, parentId, targetType: "wiki", targetId } as unknown as WikiAliasEntry;
}

describe("listDramaturgyMoveInCandidates", () => {
  const all = [
    entry("root", null, true), entry("inside", "root"),
    entry("free", null), entry("boxed", "box"), entry("box", null),
  ];
  const subtree = listDramaturgyWikiSubtree(all, "root");

  it("只给子树外的文档，根自身与子树成员都不是候选", () => {
    const out = listDramaturgyMoveInCandidates(all, subtree, "root",
      { enumerable: ALL, editable: ALL });
    expect(out.map(c => c.id).sort()).toEqual(["box", "boxed", "free"]);
  });

  it("列不到的文档不进候选——选择器里不出现自己看不见的 id", () => {
    const out = listDramaturgyMoveInCandidates(all, subtree, "root",
      { enumerable: idSet("free"), editable: ALL });
    expect(out.map(c => c.id)).toEqual(["free"]);
  });

  it("canMoveBody 是两道门的合取：本篇可编辑 ∧ 源父容器可写", () => {
    const out = listDramaturgyMoveInCandidates(all, subtree, "root",
      { enumerable: ALL, editable: idSet("free", "boxed") });
    const by = Object.fromEntries(out.map(c => [c.id, c.canMoveBody]));
    expect(by.free).toBe(true);    // 顶层：源父恒可写（根容器上没有 *@edit 这回事）
    expect(by.boxed).toBe(false);  // 有本篇的 edit，但没有 box 的 —— 挪不走
    expect(by.box).toBe(false);    // 连本篇的 edit 都没有
  });

  it("系统锚点自身不是候选，它的子文档是", () => {
    const withAnchor = [...all, entry("报告归档", null, true), entry("filed", "报告归档")];
    const out = listDramaturgyMoveInCandidates(withAnchor, subtree, "root",
      { enumerable: ALL, editable: ALL });
    expect(out.map(c => c.id)).not.toContain("报告归档");
    expect(out.map(c => c.id)).toContain("filed");
  });

  it("源父是系统锚点时视为可写（锚点无主，与 canWriteWikiContainer 同一条豁免）", () => {
    const withAnchor = [...all, entry("anchor", null, true), entry("filed", "anchor")];
    const out = listDramaturgyMoveInCandidates(withAnchor, subtree, "root",
      { enumerable: ALL, editable: idSet("filed") });
    expect(out.find(c => c.id === "filed")?.canMoveBody).toBe(true);
  });

  it("灵感库里已有指向它的链接时打标（选择器里标出来，不拦）", () => {
    const out = listDramaturgyMoveInCandidates(all, subtree, "root",
      { enumerable: ALL, editable: ALL }, [aliasTo("free", "root")]);
    expect(out.find(c => c.id === "free")?.linked).toBe(true);
    expect(out.find(c => c.id === "box")?.linked).toBe(false);
  });

  it("rootId 为 null（锚点未懒建）时不抛：没有子树可排除，全库（除锚点）都是候选", () => {
    const out = listDramaturgyMoveInCandidates(all, [], null, { enumerable: ALL, editable: ALL });
    expect(out.map(c => c.id).sort()).toEqual(["box", "boxed", "free", "inside"]);
  });
});

// ── 路由层：parentAnchor 落位 ────────────────────────────────────────────────

async function newMember(prodId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    "INSERT INTO app_user DEFAULT VALUES RETURNING id");
  const uid = rows[0].id;
  await getPool().query(
    `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')`,
    [prodId, uid]);
  return uid;
}
async function shareTo(prodId: string, wikiId: string, userId: string, level: "view" | "edit") {
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
     VALUES ($1, $2, 'wiki', '*', '*', 'create', 'direct', $2)`,
    [prodId, userId]);
}
const cookieOf = (userId: string, isAdmin: boolean) =>
  `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin })}`;

function patchReq(prodId: string, wikiId: string, userId: string, isAdmin: boolean, body: unknown) {
  return new NextRequest(`http://localhost/api/production/${prodId}/wiki/${wikiId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookieOf(userId, isAdmin) },
    body: JSON.stringify(body),
  });
}
function aliasReq(prodId: string, userId: string, isAdmin: boolean, body: unknown) {
  return new NextRequest(`http://localhost/api/production/${prodId}/wiki-alias`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieOf(userId, isAdmin) },
    body: JSON.stringify(body),
  });
}
async function anchorUntouched(prodId: string) {
  const cfg = await getPool().query(
    "SELECT dramaturgy_root_wiki_id FROM production_wiki_config WHERE production_id = $1", [prodId]);
  return cfg.rows[0]?.dramaturgy_root_wiki_id ?? null;
}

describe("PATCH /wiki 的 parentAnchor 落位（本体移入）", () => {
  let prodId: string;
  let admin: string;
  const users: string[] = [];

  beforeAll(async () => {
    ({ prodId } = await makeProduction());
    admin = await newMember(prodId);
    users.push(admin);
  });
  afterAll(async () => {
    await getPool().query("DELETE FROM wiki_alias WHERE production_id = $1", [prodId]).catch(() => {});
    await cleanupProduction(prodId).catch(() => {});
    await getPool().query("DELETE FROM app_user WHERE id = ANY($1)", [users]).catch(() => {});
  });

  it("锚点尚未懒建时，parentAnchor 补建根并把本体挂上去", async () => {
    expect((await getDramaturgyTreeConfig(prodId)).rootWikiId).toBeNull();
    const doc = await createWiki({ productionId: prodId, title: "库里的一篇", createdBy: admin });

    const res = await wikiPATCH(
      patchReq(prodId, doc.id, admin, true, { parentAnchor: "dramaturgy" }),
      { params: Promise.resolve({ id: prodId, wikiId: doc.id }) });
    expect(res.status).toBe(200);

    const rootId = (await getDramaturgyTreeConfig(prodId)).rootWikiId;
    expect(rootId).not.toBeNull();
    expect((await res.json()).wiki.parentId).toBe(rootId);
    // 落进子树＝在「灵感文档」工作区里看得见
    expect(listDramaturgyWikiSubtree(await listWikiLibrary(prodId), rootId).map(w => w.id))
      .toContain(doc.id);
  });

  it("显式 parentId 压过 parentAnchor（与 POST /wiki 同语义）", async () => {
    const box = await createWiki({ productionId: prodId, title: "别处", createdBy: admin });
    const doc = await createWiki({ productionId: prodId, title: "挂别处的", createdBy: admin });
    const res = await wikiPATCH(
      patchReq(prodId, doc.id, admin, true, { parentId: box.id, parentAnchor: "dramaturgy" }),
      { params: Promise.resolve({ id: prodId, wikiId: doc.id }) });
    expect(res.status).toBe(200);
    expect((await res.json()).wiki.parentId).toBe(box.id);
  });

  // 一轮 AI review #1 的回归证人：上一版为了把写事务挡在 400 后面，把标题校验提到了
  // canEditWiki 前面——无权的人发个空标题会拿到 400。授权必须先答。
  it("无 edit 权 + 空标题：先答 403，不是 400", async () => {
    const { prodId: clean } = await makeProduction();
    const owner = await newMember(clean);
    const outsider = await newMember(clean);
    users.push(owner, outsider);
    try {
      const doc = await createWiki({ productionId: clean, title: "别人的", createdBy: owner });
      const res = await wikiPATCH(patchReq(clean, doc.id, outsider, false, { title: "   " }),
        { params: Promise.resolve({ id: clean, wikiId: doc.id }) });
      expect(res.status).toBe(403);
    } finally {
      await cleanupProduction(clean).catch(() => {});
    }
  });

  // parentId 与 parentAnchor 同送不是客户端会做的事，但两者哪个胜必须是确定的：
  // `parentId: null` 与"字段缺席"在服务端 collapse 成同一个 falsy → 锚点胜。
  it("parentId: null 与 parentAnchor 同送时锚点胜（与 POST /wiki 同语义）", async () => {
    const rootId = (await getDramaturgyTreeConfig(prodId)).rootWikiId;
    expect(rootId).not.toBeNull();
    const doc = await createWiki({ productionId: prodId, title: "两个字段同送", createdBy: admin });
    const res = await wikiPATCH(
      patchReq(prodId, doc.id, admin, true, { parentId: null, parentAnchor: "dramaturgy" }),
      { params: Promise.resolve({ id: prodId, wikiId: doc.id }) });
    expect(res.status).toBe(200);
    expect((await res.json()).wiki.parentId).toBe(rootId);   // 不是全库顶层的 null
  });

  it("锚点已存在时复用同一个根，不重复建", async () => {
    const before = (await getDramaturgyTreeConfig(prodId)).rootWikiId;
    expect(before).not.toBeNull();
    const doc = await createWiki({ productionId: prodId, title: "第二次移入", createdBy: admin });
    const res = await wikiPATCH(
      patchReq(prodId, doc.id, admin, true, { parentAnchor: "dramaturgy" }),
      { params: Promise.resolve({ id: prodId, wikiId: doc.id }) });
    expect(res.status).toBe(200);
    expect((await res.json()).wiki.parentId).toBe(before);
    expect((await getDramaturgyTreeConfig(prodId)).rootWikiId).toBe(before);
  });

  it("认不出的 parentAnchor 是 400，不静默落到全库顶层", async () => {
    const box = await createWiki({ productionId: prodId, title: "非法锚点·容器", createdBy: admin });
    const doc = await createWiki({
      productionId: prodId, title: "非法锚点·文档", parentId: box.id, createdBy: admin });
    const res = await wikiPATCH(
      patchReq(prodId, doc.id, admin, true, { parentAnchor: "dramaturgyy" }),
      { params: Promise.resolve({ id: prodId, wikiId: doc.id }) });
    expect(res.status).toBe(400);
    // 位置没动：静默落位才是这条门要挡的东西
    expect((await listWikiLibrary(prodId)).find(w => w.id === doc.id)?.parentId).toBe(box.id);
  });

  // write-before-authz 的回归证人（#358 二轮 AI review 同一条纪律）：
  // ensureDramaturgyRootAnchor 会凭空建一篇 wiki，403 的请求不许留下这个副作用。
  it("无权把文档移出原父时 403，且不因此建出锚点", async () => {
    const { prodId: clean } = await makeProduction();
    const owner = await newMember(clean);
    const mover = await newMember(clean);
    users.push(owner, mover);
    try {
      const box = await createWiki({ productionId: clean, title: "别人的目录", createdBy: owner });
      const doc = await createWiki({
        productionId: clean, title: "别人目录里的一篇", parentId: box.id, createdBy: owner });
      await shareTo(clean, doc.id, mover, "edit");   // 有本篇的 edit，没有 box 的

      expect(await anchorUntouched(clean)).toBeNull();
      const res = await wikiPATCH(
        patchReq(clean, doc.id, mover, false, { parentAnchor: "dramaturgy" }),
        { params: Promise.resolve({ id: clean, wikiId: doc.id }) });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain("移出");
      expect(await anchorUntouched(clean)).toBeNull();   // ← 门跑在 ensure 之前
    } finally {
      await getPool().query("DELETE FROM wiki_alias WHERE production_id = $1", [clean]).catch(() => {});
      await cleanupProduction(clean).catch(() => {});
    }
  });
  // 二轮 AI review #2：锚点支原先无条件跳过落位双门，静态论证挂在**新建那一刻**的
  // 属性上。根建出来之后属性会变——有人把「戏剧构作」根的 listable 关掉，① 就不
  // 再恒真。现在根已存在就照常判，这一对（关掉→403 / 打开→200）就是那道门还活着
  // 的证人。
  it("根已存在且对我不可枚举时，锚点落位照样 403", async () => {
    const { prodId: clean } = await makeProduction();
    const owner = await newMember(clean);
    const mover = await newMember(clean);
    users.push(owner, mover);
    try {
      // 先由 admin 走一次 parentAnchor 把根建出来
      const seed = await createWiki({ productionId: clean, title: "种子", createdBy: owner });
      await wikiPATCH(patchReq(clean, seed.id, owner, true, { parentAnchor: "dramaturgy" }),
        { params: Promise.resolve({ id: clean, wikiId: seed.id }) });
      const rootId = (await getDramaturgyTreeConfig(clean)).rootWikiId!;
      expect(rootId).not.toBeNull();

      // 自己建的文档：createWiki 已经落了创建者行集，edit 门自然过
      const doc = await createWiki({ productionId: clean, title: "我的一篇", createdBy: mover });

      await setWikiListable(rootId, clean, false);
      const blocked = await wikiPATCH(
        patchReq(clean, doc.id, mover, false, { parentAnchor: "dramaturgy" }),
        { params: Promise.resolve({ id: clean, wikiId: doc.id }) });
      expect(blocked.status).toBe(403);
      expect((await listWikiLibrary(clean)).find(w => w.id === doc.id)?.parentId).toBeNull();

      await setWikiListable(rootId, clean, true);
      const ok = await wikiPATCH(
        patchReq(clean, doc.id, mover, false, { parentAnchor: "dramaturgy" }),
        { params: Promise.resolve({ id: clean, wikiId: doc.id }) });
      expect(ok.status).toBe(200);
      expect((await ok.json()).wiki.parentId).toBe(rootId);
    } finally {
      await cleanupProduction(clean).catch(() => {});
    }
  });

  // 锚点路径跳过的是**目标父**那两道（在锚点上恒真），不是内容门。少了这条，
  // "移入" 就成了一条绕开 canEditWiki 改别人文档位置的路。
  it("无本篇 edit 权时 403，锚点路径不因跳过落位双门而漏掉内容门", async () => {
    const { prodId: clean } = await makeProduction();
    const owner = await newMember(clean);
    const reader = await newMember(clean);
    users.push(owner, reader);
    try {
      const doc = await createWiki({ productionId: clean, title: "只读得到的一篇", createdBy: owner });
      await shareTo(clean, doc.id, reader, "view");
      const res = await wikiPATCH(
        patchReq(clean, doc.id, reader, false, { parentAnchor: "dramaturgy" }),
        { params: Promise.resolve({ id: clean, wikiId: doc.id }) });
      expect(res.status).toBe(403);
      expect(await anchorUntouched(clean)).toBeNull();
    } finally {
      await cleanupProduction(clean).catch(() => {});
    }
  });
});

describe("POST /wiki-alias 的 parentAnchor 落位（以链接移入）", () => {
  const users: string[] = [];
  afterAll(async () => {
    await getPool().query("DELETE FROM app_user WHERE id = ANY($1)", [users]).catch(() => {});
  });

  it("锚点尚未懒建时，建链接补建根，链接成为灵感库成员而目标一动不动", async () => {
    const { prodId } = await makeProduction();
    const admin = await newMember(prodId);
    users.push(admin);
    try {
      const doc = await createWiki({ productionId: prodId, title: "库里的一篇", createdBy: admin });
      expect((await getDramaturgyTreeConfig(prodId)).rootWikiId).toBeNull();

      const res = await aliasPOST(
        aliasReq(prodId, admin, true, { parentAnchor: "dramaturgy", targetType: "wiki", targetId: doc.id }),
        { params: Promise.resolve({ id: prodId }) });
      expect(res.status).toBe(201);
      const { alias } = await res.json();

      const rootId = (await getDramaturgyTreeConfig(prodId)).rootWikiId;
      expect(alias.parentId).toBe(rootId);
      // 目标本体没动：还在全库顶层，没被拽进子树
      const all = await listWikiLibrary(prodId);
      expect(all.find(w => w.id === doc.id)?.parentId).toBeNull();
      // 链接是工作区成员（成员判据是**位置**，与目标在哪无关）
      const subtree = listDramaturgyWikiSubtree(all, rootId);
      expect(listDramaturgyWikiAliases(
        [alias as WikiAliasEntry], subtree, rootId).map(a => a.id)).toEqual([alias.id]);
      // 移入后它不再出现在候选表里（那边已经有链接了 → 打标）
      const { moveIn } = await listDramaturgyTreeFor(
        { userId: admin, isAdmin: true, isOwner: false }, prodId, rootId);
      expect(moveIn.find(c => c.id === doc.id)?.linked).toBe(true);
    } finally {
      await getPool().query("DELETE FROM wiki_alias WHERE production_id = $1", [prodId]).catch(() => {});
      await cleanupProduction(prodId).catch(() => {});
    }
  });

  it("认不出的 parentAnchor 是 400，不静默把链接建到全库顶层", async () => {
    const { prodId } = await makeProduction();
    const admin = await newMember(prodId);
    users.push(admin);
    try {
      const doc = await createWiki({ productionId: prodId, title: "目标", createdBy: admin });
      const res = await aliasPOST(
        aliasReq(prodId, admin, true, { parentAnchor: "inspiration", targetType: "wiki", targetId: doc.id }),
        { params: Promise.resolve({ id: prodId }) });
      expect(res.status).toBe(400);
      const { rows } = await getPool().query(
        "SELECT 1 FROM wiki_alias WHERE production_id = $1", [prodId]);
      expect(rows.length).toBe(0);
    } finally {
      await getPool().query("DELETE FROM wiki_alias WHERE production_id = $1", [prodId]).catch(() => {});
      await cleanupProduction(prodId).catch(() => {});
    }
  });

  // 三轮 AI review #2：锚点支的落位门原先排在目标可达门后面，同一个请求在两支里
  // 会收到不同的那一条 403。现在两支同顺位——落位不过就是落位那条。
  it("落位与目标都不过时，报的是落位那条（两支同顺位）", async () => {
    const { prodId } = await makeProduction();
    const owner = await newMember(prodId);
    const outsider = await newMember(prodId);
    users.push(owner, outsider);
    try {
      // 根已存在但对 outsider 不可枚举 → 落位门不过
      const seed = await createWiki({ productionId: prodId, title: "种子", createdBy: owner });
      await wikiPATCH(patchReq(prodId, seed.id, owner, true, { parentAnchor: "dramaturgy" }),
        { params: Promise.resolve({ id: prodId, wikiId: seed.id }) });
      const rootId = (await getDramaturgyTreeConfig(prodId)).rootWikiId!;
      await setWikiListable(rootId, prodId, false);

      // 目标也够不着（既列不到也读不到）
      const doc = await createWiki({ productionId: prodId, title: "够不着的目标", createdBy: owner });
      await setWikiListable(doc.id, prodId, false);
      await grantCreate(prodId, outsider);

      // 目标确实够不着——否则这条测的就不是"两条门都不过时报哪一条"
      expect(await canReachAliasTarget(
        { userId: outsider, isAdmin: false, isOwner: false }, prodId, "wiki", doc.id)).toBe(false);

      const res = await aliasPOST(
        aliasReq(prodId, outsider, false, { parentAnchor: "dramaturgy", targetType: "wiki", targetId: doc.id }),
        { params: Promise.resolve({ id: prodId }) });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain("父文档");   // 不是"目标文档不存在或不可见"
    } finally {
      await getPool().query("DELETE FROM wiki_alias WHERE production_id = $1", [prodId]).catch(() => {});
      await cleanupProduction(prodId).catch(() => {});
    }
  });

  it("无 wiki@create 时 403，且不因此建出锚点", async () => {
    const { prodId } = await makeProduction();
    const owner = await newMember(prodId);
    const outsider = await newMember(prodId);
    users.push(owner, outsider);
    try {
      const doc = await createWiki({ productionId: prodId, title: "目标", createdBy: owner });
      await shareTo(prodId, doc.id, outsider, "view");

      const res = await aliasPOST(
        aliasReq(prodId, outsider, false, { parentAnchor: "dramaturgy", targetType: "wiki", targetId: doc.id }),
        { params: Promise.resolve({ id: prodId }) });
      expect(res.status).toBe(403);
      expect(await anchorUntouched(prodId)).toBeNull();
    } finally {
      await getPool().query("DELETE FROM wiki_alias WHERE production_id = $1", [prodId]).catch(() => {});
      await cleanupProduction(prodId).catch(() => {});
    }
  });
});

// ── 新增 lib 的直测（四轮 AI review #4）────────────────────────────────────

describe("readParentAnchor", () => {
  it("缺席 / null ＝没给锚点", () => {
    expect(readParentAnchor(undefined)).toEqual({ ok: true, anchor: null });
    expect(readParentAnchor(null)).toEqual({ ok: true, anchor: null });
  });
  it("唯一合法值认出来", () => {
    expect(readParentAnchor("dramaturgy")).toEqual({ ok: true, anchor: "dramaturgy" });
  });
  // 与 readTrimmedId / readPlacement 相反：这个字段猜错就是静默错落位，不猜
  it("其余一律不 ok（拼错、别的类型、非字符串）", () => {
    for (const v of ["dramaturgi", "reports", "", 1, true, {}, []]) {
      expect(readParentAnchor(v).ok).toBe(false);
    }
  });
});

describe("resolveWikiAnchorParent", () => {
  it("首次懒建、其后幂等——三个调用点拿到的是同一个根", async () => {
    const { prodId } = await makeProduction();
    try {
      expect((await getDramaturgyTreeConfig(prodId)).rootWikiId).toBeNull();
      const first = await resolveWikiAnchorParent(prodId, "dramaturgy");
      expect(first).not.toBeNull();
      expect(await resolveWikiAnchorParent(prodId, "dramaturgy")).toBe(first);
      expect(await resolveWikiAnchorParent(prodId, "dramaturgy")).toBe(first);
      expect((await listWikiLibrary(prodId)).filter(w => w.id === first).length).toBe(1);
    } finally {
      await cleanupProduction(prodId).catch(() => {});
    }
  });
});
