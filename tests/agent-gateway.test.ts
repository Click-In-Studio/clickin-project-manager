import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createNewSessionKey,
  sessionKeyOwnedBy,
  markSteerPending,
  consumeExpectedSteerFinal,
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

  it("heartbeat child key still belongs to its owner", () => {
    // Ownership ≠ visibility: heartbeat keys are filtered out of listings
    // separately, but they must not be accessible to other users either.
    const key = `agent:main:${createNewSessionKey(USER_A)}:heartbeat`;
    expect(sessionKeyOwnedBy(key, USER_A)).toBe(true);
    expect(sessionKeyOwnedBy(key, USER_B)).toBe(false);
  });
});

describe("steer expectation bookkeeping", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("consumes exactly as many finals as steers were marked", () => {
    const key = createNewSessionKey(USER_A);
    markSteerPending(key);
    markSteerPending(key);
    expect(consumeExpectedSteerFinal(key)).toBe(true);
    expect(consumeExpectedSteerFinal(key)).toBe(true);
    expect(consumeExpectedSteerFinal(key)).toBe(false);
  });

  it("expired expectations are pruned, not consumed", () => {
    vi.useFakeTimers();
    const key = createNewSessionKey(USER_A);
    markSteerPending(key);
    // Past the relay's 180s overall timeout: the relay that registered this
    // expectation has certainly stopped waiting — a fresh stream on the same
    // session must not have its genuine final swallowed by the stale entry.
    vi.advanceTimersByTime(181_000);
    expect(consumeExpectedSteerFinal(key)).toBe(false);
  });

  it("fresh expectation survives while stale ones are pruned", () => {
    vi.useFakeTimers();
    const key = createNewSessionKey(USER_A);
    markSteerPending(key);
    vi.advanceTimersByTime(181_000);
    markSteerPending(key);
    expect(consumeExpectedSteerFinal(key)).toBe(true);
    expect(consumeExpectedSteerFinal(key)).toBe(false);
  });
});
