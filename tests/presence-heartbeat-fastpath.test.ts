import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import {
  registerSSE,
  hasActiveSSEClient,
  registerCueSSE,
  hasActiveCueSSEClient,
  getPresence,
  cuePresenceFrame,
} from "@/lib/server-cache";
import { POST as presencePOST } from "@/app/api/script/[id]/presence/route";
import { POST as cuePresencePOST } from "@/app/api/production/[id]/cue-presence/route";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// #460 presence 心跳快路径：clientId 在 SSE 注册表在册 = 建连时已过权限门，
// 心跳免重跑 7 条 DB 查询。这里钉住三件事：
//  ① 快路径确实绕开权限重查（非成员 + 在册连接 → 200）——信任模型是"门在建连处"；
//  ② 慢路径没有松动（无在册连接的非成员 403、未登录 401）；
//  ③ 快路径的 key 是 (production, version, clientId) 三元组，错一个都落回慢路径。

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

afterAll(async () => {
  for (const cleanup of cleanups) cleanup();
  await cleanupProduction(prodId).catch(() => {});
  for (const uid of [ownerId, strangerId]) {
    await getPool().query("DELETE FROM app_user WHERE id = $1", [uid]).catch(() => {});
  }
});

describe("hasActiveSSEClient — 注册表即令牌", () => {
  it("在册 → true；version / clientId 错位 → false；断开 → false", () => {
    const cid = shortId();
    const cleanup = registerSSE(prodId, versionId, `${cid}:conn1`, cid, () => {});
    expect(hasActiveSSEClient(prodId, versionId, cid)).toBe(true);
    expect(hasActiveSSEClient(prodId, "other-version", cid)).toBe(false);
    expect(hasActiveSSEClient(prodId, versionId, "other-client")).toBe(false);
    cleanup();
    expect(hasActiveSSEClient(prodId, versionId, cid)).toBe(false);
  });
});

describe("script presence 心跳", () => {
  it("快路径：活跃 SSE 在册即免权限重查（非成员也 200——门在建连处）", async () => {
    const cid = shortId();
    cleanups.push(registerSSE(prodId, versionId, `${cid}:conn`, cid, () => {}));
    const res = await presencePOST(
      presenceReq(strangerId, { clientId: cid, userName: "陌生人", blockId: null, versionId }),
      scriptCtx(),
    );
    expect(res.status).toBe(200);
    expect(getPresence(prodId, versionId).some(p => p.clientId === cid)).toBe(true);
  });

  it("快路径不豁免登录：无 session 一律 401", async () => {
    const cid = shortId();
    cleanups.push(registerSSE(prodId, versionId, `${cid}:conn`, cid, () => {}));
    const res = await presencePOST(
      presenceReq(null, { clientId: cid, userName: "无名", blockId: null, versionId }),
      scriptCtx(),
    );
    expect(res.status).toBe(401);
  });

  it("version 错位不走快路径：在册连接挂在别的 version 上 → 落回慢路径 → 非成员 403", async () => {
    const cid = shortId();
    cleanups.push(registerSSE(prodId, versionId, `${cid}:conn`, cid, () => {}));
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
