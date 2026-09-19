import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { addProductionMember } from "@/lib/db";
import { createDirectGrant } from "@/lib/perm/grant-audit-db";
import { restoreMember } from "@/lib/perm/member-status";
import { createWiki } from "@/lib/wiki/content";
import { registerSSEKick, kickUserStreams, countKickableStreams } from "@/lib/sse-kick";
import {
  hasActiveSSEClient, hasActiveCueSSEClient, updatePresence, getPresence,
  updateCuePresence, cuePresenceFrame,
} from "@/lib/server-cache";
import { registerWikiSSE, wikiPresenceFrame, stopCollabListenerForTests, COLLAB_CHANNEL } from "@/lib/wiki/collab";
import { GET as scriptStreamGET } from "@/app/api/script/[id]/stream/route";
import { GET as cueStreamGET } from "@/app/api/production/[id]/cue-stream/route";
import { GET as wikiStreamGET } from "@/app/api/production/[id]/wiki/[wikiId]/stream/route";
import { POST as statusPOST } from "@/app/api/production/[id]/members/[userId]/status/route";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";

// #469 权限撤销主动断流：三条协作流只在建连时过门，此后不再重校验。修法是撤销写点
// 按 (production, user) 反查注册表主动 close，让 EventSource 重连再过门（403 即停）。
// 这里钉住：
//  ① 注册表语义（按 user / 按 production 踢、注销幂等、坏 close 不挡其余）；
//  ② 三条路由被踢后流真的结束，且整套清理跟着走——注册表摘除（#460 快路径失效）、
//     presence 移除——因为服务端 controller.close() 不会触发 cancel()；
//  ③ 撤销写点接线：停用成员 → 他的流断、重连 403；
//  ④ 跨进程：别的进程（agent-runner）经 outbox 发的 kick 指令到达本进程即踢；
//  ⑤ 静态棘轮：所有常驻 SSE 路由都登记了踢出注册表。

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

const cookieFor = (userId: string) =>
  `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;

function streamReq(url: string, userId: string): NextRequest {
  return new NextRequest(url, { headers: { cookie: cookieFor(userId) } });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (params: Record<string, string>): any => ({ params: Promise.resolve(params) });

type Reader = ReadableStreamDefaultReader<Uint8Array>;

/** 读一帧（带超时）；建连帧应当立刻到。 */
async function readFrame(reader: Reader, ms = 2000): Promise<string> {
  const r = await Promise.race([
    reader.read(),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("read timeout")), ms)),
  ]);
  if (r.done) throw new Error("stream ended early");
  return new TextDecoder().decode(r.value);
}

/** 流是否在 ms 内结束（把残余帧读完直到 done）。 */
async function endsWithin(reader: Reader, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await Promise.race([
      reader.read(),
      new Promise<null>((res) => setTimeout(() => res(null), Math.max(1, deadline - Date.now()))),
    ]);
    if (r === null) return false;
    if (r.done) return true;
  }
  return false;
}

async function openStream(
  handler: (req: NextRequest, c: unknown) => Promise<Response>,
  url: string, userId: string, params: Record<string, string>,
): Promise<Reader> {
  const res = await handler(streamReq(url, userId), ctx(params));
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const first = await readFrame(reader);
  expect(first).toContain("event: presence");
  return reader;
}

let prodId: string;
let versionId: string;
let ownerId: string;
let memberId: string;
let wikiId: string;

beforeAll(async () => {
  ownerId = await newUser();
  memberId = await newUser();
  ({ prodId, versionId } = await makeProduction(ownerId));
  await addProductionMember(prodId, ownerId);
  await addProductionMember(prodId, memberId);
  // 普通成员靠直发 grant 过 script stream 的门（不用 isAdmin 旁路——线上它恒 false）
  await createDirectGrant(prodId, memberId,
    { resourceType: "script", resourceId: "*", resourceSub: "blocks", verb: "view" }, ownerId);
  // 创建者自带这篇文档的 grant 行 → 过 wiki stream 的门
  wikiId = (await createWiki({ productionId: prodId, title: "踢出测试", body: "正文", createdBy: memberId })).id;
});

afterAll(async () => {
  kickUserStreams(prodId);
  await stopCollabListenerForTests();
  await getPool().query(`DELETE FROM wiki_collab_outbox WHERE topic IN ($1, $2)`, [wikiId, `kick:${prodId}`]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
  for (const uid of [ownerId, memberId]) {
    await getPool().query("DELETE FROM app_user WHERE id = $1", [uid]).catch(() => {});
  }
});

describe("registerSSEKick / kickUserStreams — 注册表语义", () => {
  it("按 user 踢只关他的；按 production 踢全关；注销幂等", () => {
    const pid = shortId();
    const closed: string[] = [];
    const releaseA1 = registerSSEKick(pid, "A", () => closed.push("A1"));
    const releaseA2 = registerSSEKick(pid, "A", () => closed.push("A2"));
    const releaseB = registerSSEKick(pid, "B", () => closed.push("B"));
    expect(countKickableStreams(pid)).toBe(3);
    expect(countKickableStreams(pid, "A")).toBe(2);

    expect(kickUserStreams(pid, "A")).toBe(2);
    expect(closed.sort()).toEqual(["A1", "A2"]);
    expect(countKickableStreams(pid)).toBe(1);
    releaseA1(); releaseA1(); // 被踢后路由 teardown 再注销：空操作，不误伤 B
    releaseA2();
    expect(countKickableStreams(pid, "B")).toBe(1);

    expect(kickUserStreams(pid)).toBe(1);
    expect(closed).toContain("B");
    expect(countKickableStreams(pid)).toBe(0);
    releaseB();
    expect(kickUserStreams(pid)).toBe(0);
    expect(kickUserStreams(shortId(), "nobody")).toBe(0);
  });

  it("某条 close 抛错不挡住其余连接的踢出", () => {
    const pid = shortId();
    const closed: string[] = [];
    registerSSEKick(pid, "A", () => { throw new Error("broken"); });
    registerSSEKick(pid, "A", () => closed.push("ok"));
    expect(kickUserStreams(pid, "A")).toBe(2);
    expect(closed).toEqual(["ok"]);
    expect(countKickableStreams(pid)).toBe(0);
  });
});

describe("三条路由被踢 → 流结束 + 整套清理", () => {
  it("script stream：注册表摘除（快路径失效）、presence 移除", async () => {
    const cid = shortId();
    const reader = await openStream(scriptStreamGET,
      `http://localhost/api/script/${prodId}/stream?cid=${cid}&v=${versionId}`, memberId, { id: prodId });
    updatePresence(prodId, versionId, cid, "被踢者", null);
    expect(hasActiveSSEClient(prodId, versionId, cid)).toBe(true);
    expect(countKickableStreams(prodId, memberId)).toBe(1);

    expect(kickUserStreams(prodId, memberId)).toBe(1);
    expect(await endsWithin(reader)).toBe(true);
    expect(hasActiveSSEClient(prodId, versionId, cid)).toBe(false);
    expect(getPresence(prodId, versionId).some((p) => p.clientId === cid)).toBe(false);
    expect(countKickableStreams(prodId, memberId)).toBe(0);
  });

  it("cue-stream：按 production 踢，注册表与 cue presence 一并清", async () => {
    const cid = shortId();
    const reader = await openStream(cueStreamGET,
      `http://localhost/api/production/${prodId}/cue-stream?cid=${cid}`, ownerId, { id: prodId });
    updateCuePresence(prodId, cid, "owner", null, null);
    expect(hasActiveCueSSEClient(prodId, cid)).toBe(true);

    expect(kickUserStreams(prodId)).toBe(1);
    expect(await endsWithin(reader)).toBe(true);
    expect(hasActiveCueSSEClient(prodId, cid)).toBe(false);
    expect(cuePresenceFrame(prodId)).not.toContain(cid);
  });

  it("wiki stream：在场者移除", async () => {
    const cid = shortId();
    const reader = await openStream(wikiStreamGET,
      `http://localhost/api/production/${prodId}/wiki/${wikiId}/stream?cid=${cid}`, memberId,
      { id: prodId, wikiId });
    expect(wikiPresenceFrame(wikiId)).toContain(cid);

    expect(kickUserStreams(prodId, memberId)).toBe(1);
    expect(await endsWithin(reader)).toBe(true);
    expect(wikiPresenceFrame(wikiId)).not.toContain(cid);
  });

  it("没被踢的人不受影响", async () => {
    const cidA = shortId();
    const cidB = shortId();
    const readerA = await openStream(scriptStreamGET,
      `http://localhost/api/script/${prodId}/stream?cid=${cidA}&v=${versionId}`, memberId, { id: prodId });
    const readerB = await openStream(scriptStreamGET,
      `http://localhost/api/script/${prodId}/stream?cid=${cidB}&v=${versionId}`, ownerId, { id: prodId });
    kickUserStreams(prodId, memberId);
    expect(await endsWithin(readerA)).toBe(true);
    expect(await endsWithin(readerB, 300)).toBe(false);
    expect(hasActiveSSEClient(prodId, versionId, cidB)).toBe(true);
    kickUserStreams(prodId, ownerId);
    expect(await endsWithin(readerB)).toBe(true);
  });
});

describe("撤销写点接线：停用成员", () => {
  it("owner 停用 → 被停用者的流断开，重连 403；复职后重连恢复", async () => {
    const cid = shortId();
    const url = `http://localhost/api/script/${prodId}/stream?cid=${cid}&v=${versionId}`;
    const reader = await openStream(scriptStreamGET, url, memberId, { id: prodId });

    const res = await statusPOST(
      new NextRequest(`http://localhost/api/production/${prodId}/members/${memberId}/status`, {
        method: "POST",
        headers: { cookie: cookieFor(ownerId), "content-type": "application/json" },
        body: JSON.stringify({ action: "suspend" }),
      }),
      ctx({ id: prodId, userId: memberId }),
    );
    expect(res.status).toBe(200);
    expect(await endsWithin(reader)).toBe(true);
    expect(hasActiveSSEClient(prodId, versionId, cid)).toBe(false);
    // EventSource 自动重连 → 建连门拒绝 → 浏览器停止重试：状态收敛
    expect((await scriptStreamGET(streamReq(url, memberId), ctx({ id: prodId }))).status).toBe(403);

    await restoreMember(prodId, memberId, ownerId);
    const again = await openStream(scriptStreamGET, url, memberId, { id: prodId });
    kickUserStreams(prodId, memberId);
    expect(await endsWithin(again)).toBe(true);
  });
});

describe("跨进程：agent-runner 发的 kick 指令经 outbox 到达", () => {
  it("别的进程 publish kick:<prod> → 本进程该用户的流结束", async () => {
    const cid = shortId();
    const reader = await openStream(scriptStreamGET,
      `http://localhost/api/script/${prodId}/stream?cid=${cid}&v=${versionId}`, memberId, { id: prodId });
    // LISTEN 单例随 wiki SSE 注册启动（有客户端的进程才收别的进程的帧）
    const cancelDummy = registerWikiSSE(wikiId, "listener-warmup", () => {});
    await new Promise((r) => setTimeout(r, 200));
    try {
      await getPool().query(
        `WITH ins AS (INSERT INTO wiki_collab_outbox (origin, topic, frame) VALUES ('other-host:1', $1, $2) RETURNING id)
         SELECT pg_notify($3, ins.id::text || ':other-host:1') FROM ins`,
        [`kick:${prodId}`, memberId, COLLAB_CHANNEL],
      );
      expect(await endsWithin(reader, 3000)).toBe(true);
      expect(hasActiveSSEClient(prodId, versionId, cid)).toBe(false);
    } finally {
      cancelDummy();
    }
  });
});

describe("静态棘轮：常驻 SSE 路由必须登记踢出注册表", () => {
  // 例外：AI 聊天流生命期是一轮回复（final 即关，工具调用逐次查权限）；cue 导出是一次性下载。
  const EXEMPT = new Set([
    "app/api/agent/chat/stream/route.ts",
    "app/api/production/[id]/export-cues/route.ts",
  ]);
  function walk(dir: string, out: string[]): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (name === "route.ts") out.push(p);
    }
    return out;
  }
  it("app/api 下每个 text/event-stream 路由都 import 了 registerSSEKick", () => {
    const root = process.cwd();
    const offenders: string[] = [];
    let seen = 0;
    for (const file of walk(join(root, "app/api"), [])) {
      const rel = file.slice(root.length + 1);
      const src = readFileSync(file, "utf8");
      if (!src.includes("text/event-stream") || EXEMPT.has(rel)) continue;
      seen++;
      if (!src.includes("registerSSEKick")) offenders.push(rel);
    }
    expect(seen).toBeGreaterThanOrEqual(3); // script / cue / wiki
    expect(offenders).toEqual([]);
  });
});
