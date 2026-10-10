import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { createWiki, deleteWiki, updateWiki } from "@/lib/wiki/content";
import { canViewWiki, listVisibleWikiIds } from "@/lib/wiki/perm";
import { setNodePublic, setNodeDeptShares } from "@/lib/node/db";
import { addNodeMount, removeNodeMount } from "@/lib/node/mount";
import { createEventReport } from "@/lib/ops/event-db";
import { recordWikiVisit, getWikiPersonalNavigation } from "@/lib/wiki/personal-navigation-db";
import { GET } from "@/app/api/production/[id]/wiki-personal/route";
import { POST } from "@/app/api/production/[id]/wiki/[wikiId]/visit/route";
import { GET as contentGET } from "@/app/api/production/[id]/wiki/[wikiId]/route";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";

const pool = getPool();
const users: string[] = [];
const productions: string[] = [];
let prodId: string;
let otherProdId: string;
let owner: string;
let viewer: string;
let stranger: string;
let outsider: string;
const actor = (userId: string) => ({ userId, isOwner: false, isAdmin: false });
async function newUser() {
  const { rows } = await pool.query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  users.push(rows[0].id);
  return rows[0].id;
}
async function member(userId: string, productionId = prodId) {
  await pool.query("INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')", [productionId, userId]);
}
async function grant(userId: string, type: string, id: string, sub = "*", verb = "view") {
  await pool.query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, $3, $4, $5, $6, 'direct') ON CONFLICT DO NOTHING`,
    [prodId, userId, type, id, sub, verb],
  );
}
function req(method: string, userId?: string, body?: string) {
  const cookie = userId ? `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}` : "";
  return new NextRequest("http://localhost/api/wiki-personal", { method, headers: { cookie }, ...(body ? { body } : {}) });
}
const ctx = (wikiId = "", id = prodId) => ({ params: Promise.resolve({ id, wikiId }) });
async function doc(title: string, productionId = prodId) {
  return createWiki({ productionId, title, createdBy: owner, listable: false });
}
async function count(wikiId: string, userId = viewer) {
  return Number((await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM wiki_recent_visit WHERE user_id = $1 AND wiki_id = $2", [userId, wikiId],
  )).rows[0].n);
}
beforeAll(async () => {
  [owner, viewer, stranger, outsider] = await Promise.all(Array.from({ length: 4 }, newUser));
  ({ prodId } = await makeProduction(owner));
  ({ prodId: otherProdId } = await makeProduction(owner));
  productions.push(prodId, otherProdId);
  await member(viewer);
  await member(stranger);
  await member(viewer, otherProdId);
});
afterAll(async () => {
  for (const id of productions) await cleanupProduction(id).catch(() => {});
  await pool.query("DELETE FROM app_user WHERE id = ANY($1::uuid[])", [users]).catch(() => {});
});

describe("个人导航 API 与权限边界", () => {
  it("GET / POST 未登录均 401；非成员均 403", async () => {
    const w = await doc("门");
    for (const [userId, status] of [[undefined, 401], [outsider, 403]] as const) {
      expect((await GET(req("GET", userId), ctx())).status).toBe(status);
      expect((await POST(req("POST", userId), ctx(w.id))).status).toBe(status);
    }
    expect(await count(w.id, outsider)).toBe(0);
  });
  it("单枚无关键不能记录；单文档 view 不能操作另一篇，不披露标题", async () => {
    const w = await doc("仅本人");
    const denied = await doc("不能泄露的标题");
    await grant(stranger, "character", "*", "meta");
    expect((await POST(req("POST", stranger), ctx(w.id))).status).toBe(403);
    await grant(viewer, "wiki", w.id);
    expect((await POST(req("POST", viewer), ctx(w.id))).status).toBe(204);
    const res = await POST(req("POST", viewer), ctx(denied.id));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "无权访问该文档" });
    expect(await count(denied.id)).toBe(0);
  });
  it("node id、无效 id、不存在与跨项目目标均 404，owner 也不能绕过存在性", async () => {
    const w = await doc("另项目", otherProdId);
    for (const id of [w.id, "nd_bad", "not-a-uuid", "00000000-0000-4000-8000-000000000916"]) {
      expect((await POST(req("POST", owner), ctx(id))).status).toBe(404);
    }
  });
  it("空历史是真空，响应禁止缓存且不接受其他用户查询参数", async () => {
    const res = await GET(req("GET", stranger), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ pinned: [], recent: [] });
    const request = new NextRequest(`http://localhost/api/wiki-personal?userId=${viewer}`, { headers: req("GET", stranger).headers });
    expect(await (await GET(request, ctx())).json()).toEqual({ pinned: [], recent: [] });
  });
  it("GET 列表及正文读取不会隐式记访问；POST 只接受空请求体且先过权限门", async () => {
    const w = await doc("读取不写");
    await grant(viewer, "wiki", w.id);
    expect((await contentGET(req("GET", viewer), ctx(w.id))).status).toBe(200);
    await GET(req("GET", viewer), ctx());
    expect(await count(w.id)).toBe(0);
    expect((await POST(req("POST", viewer, JSON.stringify({ userId: owner, time: 1 })), ctx(w.id))).status).toBe(400);
    expect((await POST(req("POST", stranger, "bad-json"), ctx(w.id))).status).toBe(403);
    expect(await count(w.id)).toBe(0);
  });
  it("归档项目允许访问记录；owner 无成员行仍可记录自己的历史", async () => {
    const w = await doc("归档", otherProdId);
    await pool.query("UPDATE production SET archived_at = now() WHERE id = $1", [otherProdId]);
    expect((await POST(req("POST", owner), ctx(w.id, otherProdId))).status).toBe(204);
    const data = await (await GET(req("GET", owner), ctx("", otherProdId))).json();
    expect(data.recent.map((r: { wikiId: string }) => r.wikiId)).toContain(w.id);
    await pool.query("UPDATE production SET archived_at = NULL WHERE id = $1", [otherProdId]);
  });
  it("两台设备会话共享历史，用户与项目隔离；改名返回当前标题", async () => {
    const w = await doc("改名前");
    await grant(viewer, "wiki", w.id);
    await POST(req("POST", viewer), ctx(w.id));
    await updateWiki(w.id, prodId, { title: "改名后" }, owner);
    const data = await (await GET(req("GET", viewer), ctx())).json();
    expect(data.recent.find((r: { wikiId: string }) => r.wikiId === w.id)).toMatchObject({ title: "改名后" });
    expect((await (await GET(req("GET", viewer), ctx("", otherProdId))).json()).recent).toEqual([]);
    expect((await (await GET(req("GET", stranger), ctx())).json()).recent).toEqual([]);
  });
  it("撤权不泄露任何条目但保留状态；恢复阅读权后恢复历史", async () => {
    const w = await doc("撤权历史");
    await grant(viewer, "wiki", w.id);
    await POST(req("POST", viewer), ctx(w.id));
    await pool.query("DELETE FROM production_member_grant WHERE production_id = $1 AND user_id = $2 AND resource_type = 'wiki' AND resource_id = $3", [prodId, viewer, w.id]);
    expect((await getWikiPersonalNavigation(actor(viewer), prodId)).recent.some(r => r.wikiId === w.id)).toBe(false);
    expect(await count(w.id)).toBe(1);
    await grant(viewer, "wiki", w.id);
    expect((await getWikiPersonalNavigation(actor(viewer), prodId)).recent.some(r => r.wikiId === w.id)).toBe(true);
  });
});

describe("候选集复用内容阅读门", () => {
  it("公开策略、部门分享与不可枚举文档保持单点/集合式同源", async () => {
    const w = await doc("结构阅读权");
    await setNodePublic(w.nodeId, prodId, true);
    expect(await canViewWiki(actor(stranger), prodId, w.id)).toBe(true);
    expect((await listVisibleWikiIds(actor(stranger), prodId, [w.id])).ids.has(w.id)).toBe(true);
    await pool.query("UPDATE production_policy SET value = 'off' WHERE production_id = $1 AND policy_key = 'policy.wiki_public_enabled'", [prodId]);
    expect((await listVisibleWikiIds(actor(stranger), prodId, [w.id])).ids.has(w.id)).toBe(false);
    const dept = (await pool.query<{ id: string }>("INSERT INTO production_dept (production_id, name) VALUES ($1, '个人导航测试') RETURNING id", [prodId])).rows[0].id;
    await setNodeDeptShares(w.nodeId, prodId, [dept]);
    await pool.query("INSERT INTO production_dept_member (production_id, dept_id, user_id) VALUES ($1, $2, $3)", [prodId, dept, stranger]);
    expect(await canViewWiki(actor(stranger), prodId, w.id)).toBe(true);
    await recordWikiVisit(stranger, prodId, w.id);
    expect((await getWikiPersonalNavigation(actor(stranger), prodId)).recent.some(r => r.wikiId === w.id)).toBe(true);
    const excluded = await doc("候选外公开");
    await setNodePublic(excluded.nodeId, prodId, true);
    expect((await listVisibleWikiIds(actor(stranger), prodId, [w.id])).ids.has(excluded.id)).toBe(false);
    await pool.query("DELETE FROM production_dept_member WHERE dept_id = $1", [dept]);
    expect((await listVisibleWikiIds(actor(stranger), prodId, [w.id])).ids.has(w.id)).toBe(false);
    await pool.query("UPDATE production_policy SET value = 'on' WHERE production_id = $1 AND policy_key = 'policy.wiki_public_enabled'", [prodId]);
  });
  it("宿主挂载让渡只判候选节点；撤挂后失效", async () => {
    const w = await doc("挂载阅读");
    const excluded = await doc("候选外挂载");
    await grant(viewer, "script", "*", "blocks");
    const mount = await addNodeMount({ nodeId: w.nodeId, productionId: prodId, mountType: "block", mountId: `b_${shortId()}`, createdBy: owner });
    await addNodeMount({ nodeId: excluded.nodeId, productionId: prodId, mountType: "block", mountId: `b_${shortId()}`, createdBy: owner });
    const visible = await listVisibleWikiIds(actor(viewer), prodId, [w.id]);
    expect(visible.ids.has(w.id)).toBe(true);
    expect(visible.ids.has(excluded.id)).toBe(false);
    await removeNodeMount(mount.id);
    expect((await listVisibleWikiIds(actor(viewer), prodId, [w.id])).ids.has(w.id)).toBe(false);
  });
  it("报告阅读通道仍按候选集过滤", async () => {
    const eventId = shortId();
    await pool.query("INSERT INTO production_event (id, production_id, title, created_by) VALUES ($1, $2, '测试', $3)", [eventId, prodId, owner]);
    const reportId = shortId();
    await createEventReport({ id: reportId, eventId, reportType: "rehearsal", title: "报告", body: "正文", createdBy: owner });
    const wikiId = (await pool.query<{ wiki_id: string }>("SELECT n.wiki_id FROM event_report r JOIN node n ON n.id = r.node_id WHERE r.id = $1", [reportId])).rows[0].wiki_id;
    await grant(viewer, "report", reportId, "meta");
    expect(await canViewWiki(actor(viewer), prodId, wikiId)).toBe(true);
    expect((await listVisibleWikiIds(actor(viewer), prodId, [wikiId])).ids.has(wikiId)).toBe(true);
    const excluded = await doc("不含报告的候选集");
    expect((await listVisibleWikiIds(actor(viewer), prodId, [excluded.id])).ids.has(wikiId)).toBe(false);
  });
});

describe("并发、索引与数据完整性", () => {
  it("并发访问同篇只有一行，不同篇都保留", async () => {
    const a = await doc("并发 A");
    const b = await doc("并发 B");
    await Promise.all(Array.from({ length: 20 }, (_, i) => recordWikiVisit(viewer, prodId, i % 2 ? a.id : b.id)));
    expect(await count(a.id)).toBe(1);
    expect(await count(b.id)).toBe(1);
  });
  it("旧语句等待锁后完成，不覆盖等待期间的新访问时间", async () => {
    const w = await doc("锁等待");
    await recordWikiVisit(viewer, prodId, w.id);
    const lock = await pool.connect();
    let pending: Promise<void> | undefined;
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT 1 FROM wiki_recent_visit WHERE user_id = $1 AND wiki_id = $2 FOR UPDATE", [viewer, w.id]);
      pending = recordWikiVisit(viewer, prodId, w.id);
      let waiting = false;
      for (let n = 0; n < 100 && !waiting; n++) {
        waiting = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO wiki_recent_visit%' LIMIT 1")).rows.length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      const newer = (await lock.query<{ t: string }>("UPDATE wiki_recent_visit SET last_viewed_at = statement_timestamp() WHERE user_id = $1 AND wiki_id = $2 RETURNING last_viewed_at::text AS t", [viewer, w.id])).rows[0].t;
      await lock.query("COMMIT");
      await pending;
      expect((await pool.query<{ t: string }>("SELECT last_viewed_at::text AS t FROM wiki_recent_visit WHERE user_id = $1 AND wiki_id = $2", [viewer, w.id])).rows[0].t).toBe(newer);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
      await pending;
    }
  });
  it("过滤超过一个批次的撤权记录后仍返回 20 篇；历史不裁剪、时间并列稳定", async () => {
    const u = await newUser();
    await member(u);
    const docs: string[] = [];
    for (let n = 0; n < 126; n++) {
      const w = await doc(`批次 ${n}`);
      docs.push(w.id);
      if (n < 21) await grant(u, "wiki", w.id);
      await recordWikiVisit(u, prodId, w.id);
    }
    await pool.query(
      `UPDATE wiki_recent_visit v SET last_viewed_at = '2020-01-01'::timestamptz + x.n * interval '1 microsecond'
       FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, n) WHERE v.user_id = $1 AND v.wiki_id = x.id`, [u, docs],
    );
    const data = await getWikiPersonalNavigation(actor(u), prodId);
    expect(data.recent.map(r => r.wikiId)).toEqual(docs.slice(1, 21).reverse());
    const stored = await pool.query<{ n: string }>("SELECT count(*) AS n FROM wiki_recent_visit WHERE user_id = $1 AND production_id = $2", [u, prodId]);
    expect(Number(stored.rows[0].n)).toBe(126);
    await pool.query("UPDATE wiki_recent_visit SET last_viewed_at = '2020-01-01' WHERE user_id = $1", [u]);
    expect((await getWikiPersonalNavigation(actor(u), prodId)).recent.map(r => r.wikiId)).toEqual(docs.slice(0, 21).sort().reverse().slice(0, 20));
  });
  it("数据库拒绝跨项目写入，wiki / user / production 删除级联清理", async () => {
    const w = await doc("级联文档");
    await expect(recordWikiVisit(viewer, otherProdId, w.id)).rejects.toMatchObject({ code: "23503" });
    await recordWikiVisit(viewer, prodId, w.id);
    expect(await deleteWiki(w.id, prodId)).toEqual({ ok: true });
    expect(await count(w.id)).toBe(0);
    const u = await newUser();
    const second = await doc("删除用户");
    await recordWikiVisit(u, prodId, second.id);
    await pool.query("DELETE FROM app_user WHERE id = $1", [u]);
    expect(await count(second.id, u)).toBe(0);
    const p = (await makeProduction(owner)).prodId;
    productions.push(p);
    const third = await doc("删除项目", p);
    await recordWikiVisit(viewer, p, third.id);
    await cleanupProduction(p);
    expect(await count(third.id)).toBe(0);
  });
  it("新增结构无 viewport / 设备 / 置顶字段；排序查询具有索引路径", async () => {
    const cols = (await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'wiki_recent_visit' ORDER BY ordinal_position")).rows.map(r => r.column_name);
    expect(cols).toEqual(["id", "user_id", "production_id", "wiki_id", "last_viewed_at"]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // 小工厂数据允许 planner 选 seq scan；这里只验证真实排序索引可用，不伪称大数据测量。
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>("EXPLAIN SELECT wiki_id FROM wiki_recent_visit WHERE user_id = $1 AND production_id = $2 ORDER BY last_viewed_at DESC, wiki_id DESC LIMIT 100", [viewer, prodId]);
      expect(plan.rows.map(r => r["QUERY PLAN"]).join("\n")).toContain("wiki_recent_visit_order_idx");
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});
