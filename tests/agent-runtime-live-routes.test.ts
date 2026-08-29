import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, setProductionTier, shortId } from "./factories";
import { upsertFeishuUser } from "@/lib/db";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { createNewSessionKey } from "@/lib/agent-gateway/client";
import { applyStreamLine, type Bubble, type StreamLine } from "@/lib/agent-gateway/stream-reducer";
import { runtimeOverrides, waitForIdle } from "@/lib/agent-runtime/service";

// #367 S2 真机冒烟（路由 + 真 DeepSeek + 真工具）：无 DEEPSEEK_API_KEY 时跳过。
// 验证的是整条链：POST /chat/stream → 注入链 → harness → 真模型决定调 my.productions
// → 工具真跑 → 最终回复 → SSE 行 → 现有 reducer 得到与网关时代一致的气泡。

const API_KEY = process.env.DEEPSEEK_API_KEY;
const live = it.skipIf(!API_KEY);

async function readSse(res: Response): Promise<StreamLine[]> {
  const text = await res.text();
  return text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)) as StreamLine);
}

describe("live: routes + DeepSeek + real tools", () => {
  let userId: string;
  let prodId: string;
  let cookie: string;
  const keys: string[] = [];
  const prevRuntime = process.env.AGENT_RUNTIME;

  beforeAll(async () => {
    process.env.AGENT_RUNTIME = "runner";
    delete runtimeOverrides.streamFn;
    delete runtimeOverrides.apiKey;
    ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `runtime-live-${shortId()}`, null, false));
    ({ prodId } = await makeProduction(userId));
    await setProductionTier(prodId, "pro");
    cookie = `${SESSION_COOKIE}=${createSession({ userId, name: "冒烟用户", avatarUrl: null, isAdmin: false })}`;
  });

  afterAll(async () => {
    process.env.AGENT_RUNTIME = prevRuntime;
    for (const k of keys) await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [k]).catch(() => {});
    await cleanupProduction(prodId).catch(() => {});
  });

  function req(url: string, init?: { method?: string; body?: string }): NextRequest {
    return new NextRequest(new URL(url, "http://localhost"), {
      method: init?.method ?? "GET",
      body: init?.body,
      headers: { cookie, "content-type": "application/json" },
    });
  }

  live("用户问「我参与了哪些制作」→ 模型调 my.productions（真跑）→ 回复里有工厂造的制作名", async () => {
    const key = createNewSessionKey(userId, prodId);
    keys.push(key);
    const prodName = (await getPool().query<{ name: string }>(`SELECT name FROM production WHERE id = $1`, [prodId])).rows[0].name;
    const { POST } = await import("@/app/api/agent/chat/stream/route");
    const res = await POST(req("/api/agent/chat/stream", { method: "POST", body: JSON.stringify({ sessionKey: key, message: "我参与了哪些制作？各自是什么角色？请用工具查，只回答查到的内容。" }) }));
    const lines = await readSse(res);
    await waitForIdle(key);
    const bubbles = lines.reduce<Bubble[]>((acc, l) => applyStreamLine(acc, l), []);
    console.log("[live-routes] bubbles:", JSON.stringify(bubbles, null, 1).slice(0, 1500));

    const tool = bubbles.find((b) => b.kind === "tool") as Extract<Bubble, { kind: "tool" }> | undefined;
    expect(tool?.name).toBe("clickin__my-productions");
    expect(tool?.done).toBe(true);
    const finalText = (bubbles[bubbles.length - 1] as { text?: string }).text ?? "";
    expect(finalText).toContain(prodName);
    expect(lines[lines.length - 1].type).toBe("final");

    const run = await getPool().query<{ status: string; input_tokens: number; page_key: string | null }>(`SELECT status, input_tokens, page_key FROM agent_run WHERE session_id = $1`, [key]);
    expect(run.rows[0].status).toBe("completed");
    expect(run.rows[0].input_tokens).toBeGreaterThan(0);
  }, 120_000);
});
