import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/agent/questions/route";
import { createSession, SESSION_COOKIE } from "@/lib/session";

// ask_user 问题面的 guard + 行为测试。重点：
// - 归属他人/不存在的问题统一 404（403/404 分叉会泄露 question id 存在性）
// - question.list 在老 gateway（2026.7.1-2 无 question.* 协议）上 unknown
//   method 必须降级为空列表——每次重开 running 会话都会打这条路
// - 回答协议形状：answers 双层包裹、单选也是数组

const USER_ID = "0b6ab930-e2aa-4020-8334-d749d7be82a5";
const OTHER_USER = "99999999-8888-7777-6666-555555555555";
const RAW_KEY = `clickin:chat:${USER_ID}:11111111-2222-3333-4444-555555555555`;
const CANONICAL_KEY = `agent:team:${RAW_KEY}`;
const FOREIGN_CANONICAL = `agent:team:clickin:chat:${OTHER_USER}:11111111-2222-3333-4444-555555555555`;

type FakeStore = {
  client: unknown;
  status: { state: string };
  connecting: null;
  events: EventEmitter;
  pendingApprovals: Map<string, unknown>;
  denyReasons: Map<string, unknown>;
  steerOwners: Map<string, Set<{ pending: number }>>;
  questionSessions: Map<string, { sessionKey: string; expiresAtMs: number }>;
};

const g = globalThis as unknown as { __clickinAgentGateway?: FakeStore };

let savedStore: FakeStore | undefined;
let savedToken: string | undefined;

beforeEach(() => {
  savedStore = g.__clickinAgentGateway;
  savedToken = process.env.OPENCLAW_GATEWAY_TOKEN;
});

afterEach(() => {
  g.__clickinAgentGateway = savedStore;
  if (savedToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
  else process.env.OPENCLAW_GATEWAY_TOKEN = savedToken;
});

function installFakeStore(client: unknown): FakeStore {
  process.env.OPENCLAW_GATEWAY_TOKEN = "test-token";
  const store: FakeStore = {
    client,
    status: { state: "connected" },
    connecting: null,
    events: new EventEmitter(),
    pendingApprovals: new Map(),
    denyReasons: new Map(),
    steerOwners: new Map(),
    questionSessions: new Map(),
  };
  g.__clickinAgentGateway = store;
  return store;
}

function fakeRpcClient(handlers: Record<string, (params?: unknown) => unknown>) {
  const calls: { method: string; params?: unknown }[] = [];
  return {
    calls,
    request: (method: string, params?: unknown) => {
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) return Promise.reject(new Error(`no fake handler for ${method}`));
      try {
        return Promise.resolve(handler(params));
      } catch (err) {
        return Promise.reject(err);
      }
    },
    stop: () => {},
  };
}

function makeGet(sessionKey: string | null, withAuth = true): NextRequest {
  const url = new URL("http://localhost/api/agent/questions");
  if (sessionKey) url.searchParams.set("sessionKey", sessionKey);
  const cookie = withAuth
    ? `${SESSION_COOKIE}=${createSession({ userId: USER_ID, name: "测试用户", avatarUrl: null, isAdmin: false })}`
    : "";
  return new NextRequest(url, { headers: cookie ? { Cookie: cookie } : {} });
}

function makePost(body: unknown, withAuth = true): NextRequest {
  const cookie = withAuth
    ? `${SESSION_COOKIE}=${createSession({ userId: USER_ID, name: "测试用户", avatarUrl: null, isAdmin: false })}`
    : "";
  return new NextRequest("http://localhost/api/agent/questions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const QUESTION_ITEMS = [
  { questionId: "pick", header: "方案", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] },
];

describe("GET /api/agent/questions", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await GET(makeGet(RAW_KEY, false));
    expect(res.status).toBe(401);
  });

  it("rejects missing sessionKey with 400", async () => {
    const res = await GET(makeGet(null));
    expect(res.status).toBe(400);
  });

  it("rejects another user's session with 403", async () => {
    const res = await GET(makeGet(FOREIGN_CANONICAL));
    expect(res.status).toBe(403);
  });

  it("returns empty list when gateway is unconfigured", async () => {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    g.__clickinAgentGateway = undefined;
    const res = await GET(makeGet(RAW_KEY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ questions: [] });
  });

  it("degrades unknown method (gateway without question.* protocol) to empty list", async () => {
    installFakeStore(
      fakeRpcClient({
        "question.list": () => {
          throw new Error("unknown method: question.list");
        },
      }),
    );
    const res = await GET(makeGet(RAW_KEY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ questions: [] });
  });

  it("filters by session with suffix tolerance, keeps only pending, reseeds routing map", async () => {
    const future = Date.now() + 900_000;
    const store = installFakeStore(
      fakeRpcClient({
        "question.list": () => ({
          questions: [
            { id: "q-mine", questions: QUESTION_ITEMS, sessionKey: CANONICAL_KEY, status: "pending", expiresAtMs: future },
            { id: "q-done", questions: QUESTION_ITEMS, sessionKey: CANONICAL_KEY, status: "answered", expiresAtMs: future },
            { id: "q-other", questions: QUESTION_ITEMS, sessionKey: FOREIGN_CANONICAL, status: "pending", expiresAtMs: future },
          ],
        }),
      }),
    );
    // 查询用 raw key——行里是 canonical，=== 比较会静默匹配不到（探针实证）
    const res = await GET(makeGet(RAW_KEY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { questions: { id: string }[] };
    expect(body.questions.map((q) => q.id)).toEqual(["q-mine"]);
    // 补种 id→sessionKey 映射（question.resolved 不带 sessionKey，重启后靠这里）
    expect(store.questionSessions.get("q-mine")?.sessionKey).toBe(CANONICAL_KEY);
  });
});

describe("POST /api/agent/questions", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await POST(makePost({ id: "q1", cancel: true }, false));
    expect(res.status).toBe(401);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await POST(makePost("{not json"));
    expect(res.status).toBe(400);
  });

  it("rejects missing id with 400", async () => {
    const res = await POST(makePost({ answers: { pick: ["A"] } }));
    expect(res.status).toBe(400);
  });

  it("rejects non-object answers with 400", async () => {
    const res = await POST(makePost({ id: "q1", answers: "A" }));
    expect(res.status).toBe(400);
  });

  it("another user's question answers 404, indistinguishable from nonexistent", async () => {
    const store = installFakeStore(fakeRpcClient({}));
    store.questionSessions.set("q-foreign", { sessionKey: FOREIGN_CANONICAL, expiresAtMs: Date.now() + 900_000 });
    const res = await POST(makePost({ id: "q-foreign", answers: { pick: ["A"] } }));
    // 403/404 分叉会让调用方探测 question id 是否存在——归属他人统一 404
    expect(res.status).toBe(404);
  });

  it("unknown id answers 404 (question.get also absent on old gateway)", async () => {
    installFakeStore(
      fakeRpcClient({
        "question.get": () => {
          throw new Error("unknown method: question.get");
        },
      }),
    );
    const res = await POST(makePost({ id: "q-nope", answers: { pick: ["A"] } }));
    expect(res.status).toBe(404);
  });

  it("rejects effectively-empty answers with 400", async () => {
    const store = installFakeStore(fakeRpcClient({}));
    store.questionSessions.set("q1", { sessionKey: CANONICAL_KEY, expiresAtMs: Date.now() + 900_000 });
    const res = await POST(makePost({ id: "q1", answers: { pick: [] } }));
    expect(res.status).toBe(400);
  });

  it("resolves with double-wrapped answers, single value normalized to array", async () => {
    const rpc = fakeRpcClient({ "question.resolve": () => ({}) });
    const store = installFakeStore(rpc);
    store.questionSessions.set("q1", { sessionKey: CANONICAL_KEY, expiresAtMs: Date.now() + 900_000 });
    const res = await POST(makePost({ id: "q1", answers: { pick: "A" } }));
    expect(res.status).toBe(200);
    // 协议要求即使单选也是数组，且 answers 双层包裹
    expect(rpc.calls).toEqual([
      { method: "question.resolve", params: { id: "q1", answers: { answers: { pick: ["A"] } } } },
    ]);
  });

  it("cancel resolves with cancel flag, no answers", async () => {
    const rpc = fakeRpcClient({ "question.resolve": () => ({}) });
    const store = installFakeStore(rpc);
    store.questionSessions.set("q1", { sessionKey: CANONICAL_KEY, expiresAtMs: Date.now() + 900_000 });
    const res = await POST(makePost({ id: "q1", cancel: true }));
    expect(res.status).toBe(200);
    expect(rpc.calls).toEqual([{ method: "question.resolve", params: { id: "q1", cancel: true } }]);
  });
});
