import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { createWiki, updateWiki, getWiki } from "@/lib/wiki/content";
import { POST as presencePOST } from "@/app/api/production/[id]/wiki/[wikiId]/presence/route";
import { GET as streamGET } from "@/app/api/production/[id]/wiki/[wikiId]/stream/route";
import { PATCH as wikiPATCH } from "@/app/api/production/[id]/wiki/[wikiId]/route";
import {
  registerWikiSSE, updateWikiPresence, removeWikiPresence, wikiPresenceFrame, stopCollabListenerForTests,
} from "@/lib/wiki/collab";
import { makeProduction, cleanupProduction } from "../_support/factories";

// wiki 协作（PR #247）：行锁内三路合并（消 read-then-write 竞态）+ 协作路由门

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

let prodId: string;
let creator: string;
let wikiId: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  creator = await newUser();
  const w = await createWiki({
    productionId: prodId, title: "协作文档",
    body: ["一", "二", "三", "四", "五"].join("\n"), createdBy: creator,
  });
  wikiId = w.id;
});

afterAll(async () => {
  await stopCollabListenerForTests();
  await getPool().query(`DELETE FROM wiki_collab_outbox WHERE topic = $1`, [wikiId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = $1", [creator]).catch(() => {});
});

describe("updateWiki mergeBase — 行锁内三路合并", () => {
  it("two saves from the same base both land (non-overlapping lines)", async () => {
    const base = (await getWiki(wikiId, prodId))!.body;
    // 客户端 A：改第 2 行；客户端 B：改第 5 行——都基于同一 base 顺序保存
    await updateWiki(wikiId, prodId, {
      body: base.replace("二", "二A"), mergeBase: base,
    }, creator);
    await updateWiki(wikiId, prodId, {
      body: base.replace("五", "五B"), mergeBase: base,
    }, creator);
    const final = (await getWiki(wikiId, prodId))!.body;
    expect(final).toContain("二A");
    expect(final).toContain("五B");
  });

  it("overlapping edit: later saver wins on the conflicted line only", async () => {
    const base = (await getWiki(wikiId, prodId))!.body;
    await updateWiki(wikiId, prodId, { body: base.replace("三", "三X"), mergeBase: base }, creator);
    await updateWiki(wikiId, prodId, { body: base.replace("三", "三Y"), mergeBase: base }, creator);
    const final = (await getWiki(wikiId, prodId))!.body;
    expect(final).toContain("三Y");
    expect(final).not.toContain("三X");
  });

  it("truly concurrent saves serialize via row lock (no lost update)", async () => {
    const base = (await getWiki(wikiId, prodId))!.body;
    const lines = base.split("\n");
    await Promise.all([
      updateWiki(wikiId, prodId, { body: [...lines.slice(0, -1), "尾C"].join("\n"), mergeBase: base }, creator),
      updateWiki(wikiId, prodId, { body: ["头D", ...lines.slice(1)].join("\n"), mergeBase: base }, creator),
    ]);
    const final = (await getWiki(wikiId, prodId))!.body;
    expect(final).toContain("头D");
    expect(final).toContain("尾C");
  });
});

describe("collab routes — auth guards", () => {
  const cookieFor = (userId: string, isAdmin = false) =>
    `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin })}`;
  const ctx = () => ({ params: Promise.resolve({ id: prodId, wikiId }) });

  it("presence: 401 unauthenticated / 400 bad body / 200 ok", async () => {
    const bare = new NextRequest("http://localhost/x", { method: "POST", body: "{}" });
    expect((await presencePOST(bare, ctx())).status).toBe(401);

    const badJson = new NextRequest("http://localhost/x", {
      method: "POST", headers: { Cookie: cookieFor(creator, true) }, body: "not-json",
    });
    expect((await presencePOST(badJson, ctx())).status).toBe(400);

    const noClient = new NextRequest("http://localhost/x", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieFor(creator, true) },
      body: JSON.stringify({ blockIndex: 1 }),
    });
    expect((await presencePOST(noClient, ctx())).status).toBe(400);

    const ok = new NextRequest("http://localhost/x", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieFor(creator, true) },
      body: JSON.stringify({ clientId: "c1", blockIndex: 1, offset: 3 }),
    });
    expect((await presencePOST(ok, ctx())).status).toBe(200);
  });

  it("stream: 401 unauthenticated / 403 without visibility", async () => {
    const bare = new NextRequest("http://localhost/x");
    expect((await streamGET(bare, ctx())).status).toBe(401);

    const stranger = await newUser();
    try {
      await getPool().query(
        `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')`,
        [prodId, stranger]);
      const req = new NextRequest("http://localhost/x", { headers: { Cookie: cookieFor(stranger) } });
      expect((await streamGET(req, ctx())).status).toBe(403);
    } finally {
      await getPool().query("DELETE FROM app_user WHERE id = $1", [stranger]).catch(() => {});
    }
  });
});

// #515：光标是纯位置量，presence 帧抢在内容前面到达就会在旧文档上乱跳。保存带上的
// 光标要**静默**落注册表、随 update 帧同帧发出——不能多推一条 presence 帧。
describe("PATCH 带光标 — 光标随 update 帧同帧到达", () => {
  const cookieFor = (userId: string) =>
    `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: true })}`;
  const ctx = () => ({ params: Promise.resolve({ id: prodId, wikiId }) });
  const patch = (body: unknown) => wikiPATCH(new NextRequest("http://localhost/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookieFor(creator) },
    body: JSON.stringify(body),
  }), ctx());
  const info = { userId: "u", userName: "甲", avatarUrl: null };
  const peerOf = (cid: string) =>
    (JSON.parse(wikiPresenceFrame(wikiId).replace(/^event: presence\ndata: /, "")) as { clientId: string; blockIndex: number | null; offset: number | null }[])
      .find(p => p.clientId === cid);

  it("在场的发起端：update 帧带 cursor、注册表已更新、其前后没有多出 presence 帧", async () => {
    const frames: string[] = [];
    const cancel = registerWikiSSE(wikiId, "obs", (f) => frames.push(f));
    updateWikiPresence(wikiId, "cA", info, { blockIndex: 0, offset: 0 });
    frames.length = 0; // 入场那帧不算
    try {
      const body = (await getWiki(wikiId, prodId))!.body;
      const res = await patch({ body: body + "\n六", baseBody: body, clientId: "cA", cursor: { blockIndex: 5, offset: 1 } });
      expect(res.status).toBe(200);
      expect(frames).toHaveLength(1);
      expect(frames[0].startsWith("event: update\n")).toBe(true);
      const data = JSON.parse(frames[0].replace(/^event: update\ndata: /, ""));
      expect(data.byClientId).toBe("cA");
      expect(data.cursor).toEqual({ blockIndex: 5, offset: 1 });
      expect(peerOf("cA")).toMatchObject({ blockIndex: 5, offset: 1 });
    } finally {
      cancel();
      removeWikiPresence(wikiId, "cA");
    }
  });

  it("不带 cursor 的保存（老客户端 / AI）：帧不带 cursor，注册表不动", async () => {
    updateWikiPresence(wikiId, "cB", info, { blockIndex: 2, offset: 3 });
    const frames: string[] = [];
    const cancel = registerWikiSSE(wikiId, "obs2", (f) => frames.push(f));
    try {
      const body = (await getWiki(wikiId, prodId))!.body;
      const res = await patch({ body: body + "\n七", baseBody: body, clientId: "cB" });
      expect(res.status).toBe(200);
      expect(frames).toHaveLength(1);
      expect(JSON.parse(frames[0].replace(/^event: update\ndata: /, ""))).not.toHaveProperty("cursor");
      expect(peerOf("cB")).toMatchObject({ blockIndex: 2, offset: 3 });
    } finally {
      cancel();
      removeWikiPresence(wikiId, "cB");
    }
  });

  it("发起端不在场（SSE 已断的卸载兜底保存）：不造幽灵条目", async () => {
    const body = (await getWiki(wikiId, prodId))!.body;
    const res = await patch({ body: body + "\n八", baseBody: body, clientId: "ghost", cursor: { blockIndex: 1, offset: 0 } });
    expect(res.status).toBe(200);
    expect(peerOf("ghost")).toBeUndefined();
  });

  it("形状不对的 cursor 当缺席；null 是阅读态", async () => {
    updateWikiPresence(wikiId, "cC", info, { blockIndex: 2, offset: 3 });
    try {
      let body = (await getWiki(wikiId, prodId))!.body;
      expect((await patch({ body: body + "\n九", baseBody: body, clientId: "cC", cursor: { blockIndex: "x" } })).status).toBe(200);
      expect(peerOf("cC")).toMatchObject({ blockIndex: 2, offset: 3 });
      body = (await getWiki(wikiId, prodId))!.body;
      expect((await patch({ body: body + "\n十", baseBody: body, clientId: "cC", cursor: null })).status).toBe(200);
      expect(peerOf("cC")).toMatchObject({ blockIndex: null, offset: null });
    } finally {
      removeWikiPresence(wikiId, "cC");
    }
  });
});
