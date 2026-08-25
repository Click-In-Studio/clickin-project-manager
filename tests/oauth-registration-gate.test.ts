import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as initiateHandler } from "@/app/api/auth/[platform]/initiate/route";
import { GET as callbackHandler } from "@/app/api/auth/[platform]/callback/route";
import { feishuPlatform } from "@/lib/platform/feishu";
import { upsertFeishuUser } from "@/lib/db";
import { createInvite } from "@/lib/invite-db";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { getPool } from "@/lib/pg";

// OAuth 通道的注册门（lib/registration-gate.ts + [platform]/callback）：
//   · 凭据（邀请码 / 邀请 token）经 initiate 收进 httpOnly cookie，跨越「跳到飞书
//     再跳回来」这一次往返——不编进 state，否则会随授权 URL 落进第三方日志。
//   · 回调三段式：handleAuthCallback 换身份 → 过门 → completeLogin 建号。
//     门拒绝时**什么都不落库**，这是「注册由本人显式完成」的底线。
//
// 飞书 API 不可达，spy 掉 handleAuthCallback 即可——它正是「只验证不建号」的那一段。

const cleanupUserIds: string[] = [];
const cleanupProdIds: string[] = [];
const cleanupCodes: string[] = [];

async function countUsers(): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>("SELECT count(*) AS n FROM app_user");
  return Number(rows[0].n);
}

async function makeRegCode(): Promise<string> {
  const code = `REG-${shortId()}`;
  cleanupCodes.push(code);
  await getPool().query(
    "INSERT INTO registration_code (code, max_uses, used_count) VALUES ($1, 1, 0)",
    [code],
  );
  return code;
}

function spyIdentity(openId: string, name = "飞书新人") {
  return vi.spyOn(feishuPlatform, "handleAuthCallback").mockResolvedValue({
    platformUserId: openId,
    name,
    avatarUrl: undefined,
    auth: { accessToken: `tok-${shortId()}`, expiresAt: Date.now() + 3600_000 },
  });
}

/** 走一遍 initiate，取出它下发的两个 cookie，拼成回调请求的 Cookie 头。 */
async function initiateAndGetCookies(query: string): Promise<{ cookie: string; state: string }> {
  const res = await initiateHandler(
    new NextRequest(`http://localhost/api/auth/feishu/initiate${query}`),
    { params: Promise.resolve({ platform: "feishu" }) },
  );
  const set = res.headers.getSetCookie();
  const pick = (n: string) => set.find(c => c.startsWith(`${n}=`))!.split(";")[0];
  const stateCookie = pick("oauth_state");
  return { cookie: `${stateCookie}; ${pick("oauth_ctx")}`, state: stateCookie.split("=")[1] };
}

async function callback(state: string, cookie: string) {
  return callbackHandler(
    new NextRequest(`http://localhost/api/auth/feishu/callback?code=oauth-code&state=${state}`, {
      headers: { cookie },
    }),
    { params: Promise.resolve({ platform: "feishu" }) },
  );
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

afterAll(async () => {
  const pool = getPool();
  for (const id of cleanupProdIds) await cleanupProduction(id).catch(() => {});
  await pool.query("DELETE FROM app_user WHERE id = ANY($1)", [cleanupUserIds]).catch(() => {});
  await pool.query("DELETE FROM registration_code WHERE code = ANY($1)", [cleanupCodes]).catch(() => {});
});

describe("initiate 把注册凭据收进上下文 cookie", () => {
  it("reg_code / invite_token / next 进 oauth_ctx，授权 URL 里只有 nonce", async () => {
    const res = await initiateHandler(
      new NextRequest("http://localhost/api/auth/feishu/initiate?reg_code=REG-ABC&invite_token=tok-1&next=%2Finvite%2Fx"),
      { params: Promise.resolve({ platform: "feishu" }) },
    );
    const set = res.headers.getSetCookie();
    const ctxRaw = decodeURIComponent(set.find(c => c.startsWith("oauth_ctx="))!.split(";")[0].slice("oauth_ctx=".length));
    const ctx = JSON.parse(ctxRaw) as Record<string, string>;

    expect(ctx.registrationCode).toBe("REG-ABC");
    expect(ctx.inviteToken).toBe("tok-1");
    expect(ctx.next).toBe("/invite/x");

    // 凭据不得出现在跳给飞书的授权 URL 里
    const authUrl = res.headers.get("location")!;
    expect(authUrl).toContain(ctx.nonce);
    expect(authUrl).not.toContain("REG-ABC");
    expect(authUrl).not.toContain("tok-1");
  });

  it("ctx cookie 是 httpOnly（JS 读不到凭据）", async () => {
    const res = await initiateHandler(
      new NextRequest("http://localhost/api/auth/feishu/initiate?reg_code=REG-X"),
      { params: Promise.resolve({ platform: "feishu" }) },
    );
    const ctxCookie = res.headers.getSetCookie().find(c => c.startsWith("oauth_ctx="))!;
    expect(ctxCookie.toLowerCase()).toContain("httponly");
  });
});

describe("飞书回调过注册门", () => {
  it("开启 + 无正当性 → 不建号，重定向回登录页并透出文案", async () => {
    vi.stubEnv("REGISTRATION_INVITE_ONLY", "1");
    spyIdentity(`gate-cb-${shortId()}`);
    const before = await countUsers();

    const { cookie, state } = await initiateAndGetCookies("");
    const res = await callback(state, cookie);

    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("error")).toContain("邀请码");
    // 底线：拒绝时什么都不落库
    expect(await countUsers()).toBe(before);
  });

  it("开启 + 邀请码 → 建号并登录", async () => {
    vi.stubEnv("REGISTRATION_INVITE_ONLY", "1");
    const openId = `gate-cb-${shortId()}`;
    spyIdentity(openId);
    const code = await makeRegCode();

    const { cookie, state } = await initiateAndGetCookies(`?reg_code=${code}`);
    const res = await callback(state, cookie);

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");

    const { rows } = await getPool().query<{ user_id: string }>(
      "SELECT user_id FROM user_platform_identity WHERE platform_id='feishu' AND platform_user_id=$1",
      [openId],
    );
    expect(rows).toHaveLength(1);
    cleanupUserIds.push(rows[0].user_id);
  });

  it("开启 + 飞书定向邀请 → 建号（无需额外要码）", async () => {
    vi.stubEnv("REGISTRATION_INVITE_ONLY", "1");
    const owner = (await upsertFeishuUser(`test-open-${shortId()}`, `邀请人${shortId()}`, null, false)).userId;
    cleanupUserIds.push(owner);
    const { prodId } = await makeProduction(owner);
    cleanupProdIds.push(prodId);

    const openId = `gate-cb-${shortId()}`;
    await createInvite({ productionId: prodId, createdBy: owner, feishuOpenId: openId, expiresInDays: 7, maxUses: 1 });
    spyIdentity(openId);

    const { cookie, state } = await initiateAndGetCookies("");
    const res = await callback(state, cookie);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");

    const { rows } = await getPool().query<{ user_id: string }>(
      "SELECT user_id FROM user_platform_identity WHERE platform_id='feishu' AND platform_user_id=$1",
      [openId],
    );
    expect(rows).toHaveLength(1);
    cleanupUserIds.push(rows[0].user_id);
  });

  it("开启：老用户照常登录，不受门影响", async () => {
    vi.stubEnv("REGISTRATION_INVITE_ONLY", "1");
    const openId = `gate-cb-${shortId()}`;
    const { userId } = await upsertFeishuUser(openId, `老用户${shortId()}`, null, false);
    cleanupUserIds.push(userId);
    spyIdentity(openId);
    const before = await countUsers();

    const { cookie, state } = await initiateAndGetCookies("");
    const res = await callback(state, cookie);

    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
    expect(await countUsers()).toBe(before); // 老用户不产生新账号
  });

  it("开关关闭 → 一切照旧，新身份直接建号", async () => {
    vi.stubEnv("REGISTRATION_INVITE_ONLY", "");
    const openId = `gate-cb-${shortId()}`;
    spyIdentity(openId);

    const { cookie, state } = await initiateAndGetCookies("");
    const res = await callback(state, cookie);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");

    const { rows } = await getPool().query<{ user_id: string }>(
      "SELECT user_id FROM user_platform_identity WHERE platform_id='feishu' AND platform_user_id=$1",
      [openId],
    );
    expect(rows).toHaveLength(1);
    cleanupUserIds.push(rows[0].user_id);
  });

  it("上下文 nonce 与 state 不符 → 凭据不被采信（防串用旧上下文）", async () => {
    vi.stubEnv("REGISTRATION_INVITE_ONLY", "1");
    spyIdentity(`gate-cb-${shortId()}`);
    const code = await makeRegCode();

    // 拿 A 次发起的 ctx（含码），配 B 次发起的 state
    const a = await initiateAndGetCookies(`?reg_code=${code}`);
    const b = await initiateAndGetCookies("");
    const ctxOfA = a.cookie.split("; ").find(c => c.startsWith("oauth_ctx="))!;
    const stateOfB = b.cookie.split("; ").find(c => c.startsWith("oauth_state="))!;

    const before = await countUsers();
    const res = await callback(b.state, `${stateOfB}; ${ctxOfA}`);

    // 码没被采信 → 无正当性 → 拒绝且不建号
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toContain("邀请码");
    expect(await countUsers()).toBe(before);
  });

  it("回跳目标只认站内路径（防 open redirect）", async () => {
    vi.stubEnv("REGISTRATION_INVITE_ONLY", "");
    const openId = `gate-cb-${shortId()}`;
    spyIdentity(openId);

    const { cookie, state } = await initiateAndGetCookies("?next=%2F%2Fevil.com");
    const res = await callback(state, cookie);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.host).toBe("localhost");
    expect(loc.pathname).toBe("/");

    const { rows } = await getPool().query<{ user_id: string }>(
      "SELECT user_id FROM user_platform_identity WHERE platform_id='feishu' AND platform_user_id=$1",
      [openId],
    );
    if (rows[0]) cleanupUserIds.push(rows[0].user_id);
  });
});
