import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import {
  registerSSE,
  hasActiveSSEUser,
  registerCueSSE,
  hasActiveCueSSEClient,
  getPresence,
  updatePresence,
  removePresence,
  cuePresenceFrame,
  updateCuePresence,
  removeCuePresence,
} from "@/lib/server-cache";
import { PRESENCE_STALE_MS } from "@/lib/presence-heartbeat";
import { POST as presencePOST } from "@/app/api/script/[id]/presence/route";
import { POST as cuePresencePOST } from "@/app/api/production/[id]/cue-presence/route";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";

// #460 presence 心跳快路径：本人在 SSE 注册表在册 = 建连时已过权限门，
// 心跳免重跑 7 条 DB 查询。这里钉住三件事：
//  ① 快路径确实绕开权限重查（非成员 + 在册连接 → 200）——信任模型是"门在建连处"；
//  ② 慢路径没有松动（无在册连接的非成员 403、未登录 401）；
//  ③ 快路径的 key 是 (production, version, session 用户) 三元组，错一个都落回慢路径。
// #578 改按人核对：多标签页共用一条 SSE 时 cid 是 `stream:<key>`，按 cid 对永远落空；
// 且 cid 由客户端自报，按 cid 等于允许任何登录用户冒用在册 cid 绕门（④⑤）。

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

let prodId: string;
let versionId: string;
let ownerId: string;
let strangerId: string;
const cleanups: Array<() => unknown> = [];

const cookieFor = (userId: string) =>
  `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;

function presenceReq(userId: string | null, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost/api/script/${prodId}/presence`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: userId ? { cookie: cookieFor(userId) } : {},
  });
}

const scriptCtx = () => ({ params: Promise.resolve({ id: prodId }) });

beforeAll(async () => {
  ownerId = await newUser();
  strangerId = await newUser();
  ({ prodId, versionId } = await makeProduction(ownerId));
});

// 按人核对后在册连接会跨用例串味（同一个 strangerId），每条用例后就拆
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  for (const uid of [ownerId, strangerId]) {
    await getPool().query("DELETE FROM app_user WHERE id = $1", [uid]).catch(() => {});
  }
});

describe("hasActiveSSEUser — 注册表即令牌", () => {
  it("同人在册 → true；version / user 错位 → false；断开 → false", () => {
    const cleanup = registerSSE(prodId, versionId, `stream:${prodId}:${versionId}:conn`, `stream:${prodId}:${versionId}`, strangerId, () => {});
    expect(hasActiveSSEUser(prodId, versionId, strangerId)).toBe(true);
    expect(hasActiveSSEUser(prodId, "other-version", strangerId)).toBe(false);
    expect(hasActiveSSEUser(prodId, versionId, ownerId)).toBe(false);
    cleanup();
    expect(hasActiveSSEUser(prodId, versionId, strangerId)).toBe(false);
  });
});

describe("script presence 心跳", () => {
  it("快路径：活跃 SSE 在册即免权限重查（非成员也 200——门在建连处）", async () => {
    const cid = shortId();
    cleanups.push(registerSSE(prodId, versionId, `${cid}:conn`, cid, strangerId, () => {}));
    const res = await presencePOST(
      presenceReq(strangerId, { clientId: cid, userName: "陌生人", blockId: null, versionId }),
      scriptCtx(),
    );
    expect(res.status).toBe(200);
    expect(getPresence(prodId, versionId).some(p => p.clientId === cid)).toBe(true);
  });

  it("快路径（④ 按人）：leader 标签页的 cid 是 stream:<key>，本标签页另有 cid，同人也走快路径", async () => {
    const leaderCid = `stream:${prodId}:${versionId}`;
    cleanups.push(registerSSE(prodId, versionId, `${leaderCid}:conn`, leaderCid, strangerId, () => {}));
    const tabCid = shortId();
    const res = await presencePOST(
      presenceReq(strangerId, { clientId: tabCid, userName: "陌生人", blockId: null, versionId }),
      scriptCtx(),
    );
    expect(res.status).toBe(200);
    expect(getPresence(prodId, versionId).some(p => p.clientId === tabCid)).toBe(true);
  });

  it("⑤ 不串人：在册的是别人的连接，本人无连接 → 慢路径 → 非成员 403；冒用那条连接的 cid 也不行", async () => {
    const cid = shortId();
    cleanups.push(registerSSE(prodId, versionId, `${cid}:conn`, cid, ownerId, () => {}));
    for (const claimed of [shortId(), cid]) {
      const res = await presencePOST(
        presenceReq(strangerId, { clientId: claimed, userName: "陌生人", blockId: null, versionId }),
        scriptCtx(),
      );
      expect(res.status, `clientId=${claimed}`).toBe(403);
    }
  });

  it("快路径不豁免登录：无 session 一律 401", async () => {
    const cid = shortId();
    cleanups.push(registerSSE(prodId, versionId, `${cid}:conn`, cid, strangerId, () => {}));
    const res = await presencePOST(
      presenceReq(null, { clientId: cid, userName: "无名", blockId: null, versionId }),
      scriptCtx(),
    );
    expect(res.status).toBe(401);
  });

  it("version 错位不走快路径：在册连接挂在别的 version 上 → 落回慢路径 → 非成员 403", async () => {
    const cid = shortId();
    cleanups.push(registerSSE(prodId, versionId, `${cid}:conn`, cid, strangerId, () => {}));
    const res = await presencePOST(
      presenceReq(strangerId, { clientId: cid, userName: "陌生人", blockId: null, versionId: "not-my-version" }),
      scriptCtx(),
    );
    expect(res.status).toBe(403);
  });

  it("慢路径守住：无在册连接的非成员 403", async () => {
    const res = await presencePOST(
      presenceReq(strangerId, { clientId: shortId(), userName: "陌生人", blockId: null, versionId }),
      scriptCtx(),
    );
    expect(res.status).toBe(403);
  });

  it("慢路径放行：owner 无在册连接也 200（原行为回归钉）", async () => {
    const cid = shortId();
    const res = await presencePOST(
      presenceReq(ownerId, { clientId: cid, userName: "老板", blockId: null, versionId }),
      scriptCtx(),
    );
    expect(res.status).toBe(200);
    expect(getPresence(prodId, versionId).some(p => p.clientId === cid)).toBe(true);
  });
});

describe("cue presence 心跳", () => {
  const cueCtx = () => ({ params: Promise.resolve({ id: prodId }) });

  function cueReq(userId: string | null, body: Record<string, unknown>): NextRequest {
    return new NextRequest(`http://localhost/api/production/${prodId}/cue-presence`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: userId ? { cookie: cookieFor(userId) } : {},
    });
  }

  it("快路径：cue SSE 在册的非成员 200；断开后同人 403", async () => {
    const cid = shortId();
    const cleanup = registerCueSSE(prodId, cid, () => {});
    expect(hasActiveCueSSEClient(prodId, cid)).toBe(true);

    const ok = await cuePresencePOST(
      cueReq(strangerId, { clientId: cid, userName: "陌生人", listId: null, cueId: null }),
      cueCtx(),
    );
    expect(ok.status).toBe(200);
    expect(cuePresenceFrame(prodId)).toContain(cid);

    cleanup();
    expect(hasActiveCueSSEClient(prodId, cid)).toBe(false);
    const denied = await cuePresencePOST(
      cueReq(strangerId, { clientId: cid, userName: "陌生人", listId: null, cueId: null }),
      cueCtx(),
    );
    expect(denied.status).toBe(403);
  });

  it("快路径不豁免登录：无 session 401", async () => {
    const cid = shortId();
    const cleanup = registerCueSSE(prodId, cid, () => {});
    cleanups.push(cleanup);
    const res = await cuePresencePOST(
      cueReq(null, { clientId: cid, userName: "无名", listId: null, cueId: null }),
      cueCtx(),
    );
    expect(res.status).toBe(401);
  });
});

// #578 心跳：同值只续 updatedAt 不广播（每个可见标签页每 30s 一拍，逐拍广播全场
// = N² 帧 + ScriptEditor 重渲染 N 次）；过期条目视同缺席，续命必须重新广播才回得来。
describe("同值心跳不广播、过期续命重新广播（#578）", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("script：同块同名心跳零帧；换块一帧；过期后同值心跳也要一帧", () => {
    const frames: string[] = [];
    const cid = shortId();
    const cleanup = registerSSE(prodId, versionId, `obs:${cid}`, "obs", ownerId, (f) => frames.push(f));
    try {
      updatePresence(prodId, versionId, cid, "甲", "b1");
      expect(frames).toHaveLength(1);
      updatePresence(prodId, versionId, cid, "甲", "b1");
      updatePresence(prodId, versionId, cid, "甲", "b1");
      expect(frames).toHaveLength(1);
      updatePresence(prodId, versionId, cid, "甲", "b2");
      expect(frames).toHaveLength(2);

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + PRESENCE_STALE_MS + 1);
      expect(getPresence(prodId, versionId).some(p => p.clientId === cid)).toBe(false);
      updatePresence(prodId, versionId, cid, "甲", "b2");
      expect(frames).toHaveLength(3);
      expect(getPresence(prodId, versionId).some(p => p.clientId === cid)).toBe(true);
    } finally {
      cleanup();
      removePresence(prodId, versionId, cid);
    }
  });

  it("cue：同 list/cue 心跳零帧；过期后续命一帧", () => {
    const frames: string[] = [];
    const cid = shortId();
    const cleanup = registerCueSSE(prodId, `obs:${cid}`, (f) => frames.push(f));
    try {
      updateCuePresence(prodId, cid, "甲", "L1", "c1");
      expect(frames).toHaveLength(1);
      updateCuePresence(prodId, cid, "甲", "L1", "c1");
      expect(frames).toHaveLength(1);
      updateCuePresence(prodId, cid, "甲", "L1", null);
      expect(frames).toHaveLength(2);

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + PRESENCE_STALE_MS + 1);
      expect(cuePresenceFrame(prodId)).not.toContain(cid);
      updateCuePresence(prodId, cid, "甲", "L1", null);
      expect(frames).toHaveLength(3);
      expect(cuePresenceFrame(prodId)).toContain(cid);
    } finally {
      cleanup();
      removeCuePresence(prodId, cid);
    }
  });
});
