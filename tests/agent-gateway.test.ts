import { describe, it, expect } from "vitest";
import {
  createNewSessionKey,
  sessionKeyOwnedBy,
  markSteerPending,
  createSteerOwner,
} from "../lib/agent-gateway/client";

// Pure-function tests for the per-user session namespace — the entire
// user-isolation boundary of the agent gateway rests on these two.

const USER_A = "0b6ab930-e2aa-4020-8334-d749d7be82a5";
const USER_B = "11111111-2222-3333-4444-555555555555";

describe("agent gateway session keys", () => {
  it("createNewSessionKey embeds the userId namespace", () => {
    const key = createNewSessionKey(USER_A);
    expect(key.startsWith(`clickin:chat:${USER_A}:`)).toBe(true);
  });

  it("two keys for the same user are distinct", () => {
    expect(createNewSessionKey(USER_A)).not.toBe(createNewSessionKey(USER_A));
  });

  it("owner matches bare key", () => {
    const key = createNewSessionKey(USER_A);
    expect(sessionKeyOwnedBy(key, USER_A)).toBe(true);
  });

  it("owner matches canonical agent-prefixed key", () => {
    const key = `agent:main:${createNewSessionKey(USER_A)}`;
    expect(sessionKeyOwnedBy(key, USER_A)).toBe(true);
  });

  it("other user does not match", () => {
    const key = createNewSessionKey(USER_A);
    expect(sessionKeyOwnedBy(key, USER_B)).toBe(false);
    expect(sessionKeyOwnedBy(`agent:main:${key}`, USER_B)).toBe(false);
  });

  it("userId prefix collision does not grant access", () => {
    // USER_A's id as a *prefix* of a longer id must not match — the
    // trailing colon in the namespace guards this.
    const fakeLongerUser = `${USER_A}ff`;
    const key = createNewSessionKey(fakeLongerUser);
    expect(sessionKeyOwnedBy(key, USER_A)).toBe(false);
  });

  it("unrelated namespaces never match", () => {
    expect(sessionKeyOwnedBy("mindweave:chat:xyz", USER_A)).toBe(false);
    expect(sessionKeyOwnedBy(`agent:main:other:${USER_A}:x`, USER_A)).toBe(false);
    expect(sessionKeyOwnedBy("", USER_A)).toBe(false);
  });

  it("production session key embeds production id and stays owned", () => {
    const key = createNewSessionKey(USER_A, "t3k9xa1b");
    expect(key).toMatch(new RegExp(`^clickin:chat:${USER_A}:t3k9xa1b:[0-9a-f-]{36}$`));
    expect(sessionKeyOwnedBy(key, USER_A)).toBe(true);
    expect(sessionKeyOwnedBy(`agent:team:${key}`, USER_A)).toBe(true);
    expect(sessionKeyOwnedBy(key, USER_B)).toBe(false);
  });

  it("invalid production id is rejected at issuance (key injection guard)", () => {
    expect(() => createNewSessionKey(USER_A, "evil:inject")).toThrow();
    expect(() => createNewSessionKey(USER_A, "")).toThrow();
  });

  it("heartbeat child key still belongs to its owner", () => {
    // Ownership ≠ visibility: heartbeat keys are filtered out of listings
    // separately, but they must not be accessible to other users either.
    const key = `agent:main:${createNewSessionKey(USER_A)}:heartbeat`;
    expect(sessionKeyOwnedBy(key, USER_A)).toBe(true);
    expect(sessionKeyOwnedBy(key, USER_B)).toBe(false);
  });
});

describe("steer expectation bookkeeping (connection-owned)", () => {
  // 期望的所有权在连接上，不再用 TTL 猜孤儿：连接关闭（release）期望随之
  // 消失，无论连接因 approval/长工具调用活了多久，都不会误删或漏删。

  it("consumes exactly as many finals as steers were marked", () => {
    const key = createNewSessionKey(USER_A);
    const owner = createSteerOwner(key);
    expect(markSteerPending(key)).toBe(true);
    expect(markSteerPending(key)).toBe(true);
    expect(owner.consume()).toBe(true);
    expect(owner.consume()).toBe(true);
    expect(owner.consume()).toBe(false);
    owner.release();
  });

  it("steer with nobody listening reports false and leaves nothing behind", () => {
    const key = createNewSessionKey(USER_A);
    expect(markSteerPending(key)).toBe(false);
    const lateOwner = createSteerOwner(key);
    expect(lateOwner.consume()).toBe(false); // 早于注册的 steer 不会凭空出现
    lateOwner.release();
  });

  it("released owner's expectations die with it — next stream is unaffected", () => {
    const key = createNewSessionKey(USER_A);
    const dying = createSteerOwner(key);
    markSteerPending(key);
    dying.release(); // 连接中断（用户关标签页）
    const next = createSteerOwner(key);
    expect(next.consume()).toBe(false); // 下一条流不会误吞真 final
    expect(markSteerPending(key)).toBe(true);
    expect(next.consume()).toBe(true);
    next.release();
  });

  it("canonical key attach routes steers to the same owner without double-count", () => {
    const raw = createNewSessionKey(USER_A);
    const canonical = `agent:main:${raw}`;
    const owner = createSteerOwner(raw);
    owner.attachKey(canonical);
    owner.attachKey(canonical); // 幂等
    expect(markSteerPending(canonical)).toBe(true);
    expect(owner.consume()).toBe(true);
    expect(owner.consume()).toBe(false);
    owner.release();
    expect(markSteerPending(canonical)).toBe(false);
    expect(markSteerPending(raw)).toBe(false);
  });

  it("multiple watchers on one session each get their own expectation", () => {
    const key = createNewSessionKey(USER_A);
    const a = createSteerOwner(key);
    const b = createSteerOwner(key);
    markSteerPending(key);
    expect(a.consume()).toBe(true);
    expect(b.consume()).toBe(true); // 各自独立，互不抢占
    expect(a.consume()).toBe(false);
    a.release();
    b.release();
  });
});
