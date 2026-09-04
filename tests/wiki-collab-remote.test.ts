import { describe, it, expect, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import {
  registerWikiSSE, registerWikiLibrarySSE, broadcastWikiUpdate, broadcastWikiLibraryChange,
  stopCollabListenerForTests, COLLAB_CHANNEL, COLLAB_ORIGIN,
} from "@/lib/wiki/collab";
import { shortId } from "./factories";

// #367 切换后真人校出：AI 在 agent-runner 进程写文档，浏览器 SSE 挂在 next 进程，
// 内存注册表不跨进程 → 写操作后页面不再自动刷新。修法：帧落 wiki_collab_outbox +
// pg_notify，持有 SSE 的进程 LISTEN 后推本地客户端；自己发的回声要跳过。

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 模拟另一个进程：直接落行 + notify，origin 不是本进程 */
async function publishFromOtherProcess(topic: string, frame: string): Promise<void> {
  await getPool().query(
    `WITH ins AS (INSERT INTO wiki_collab_outbox (origin, topic, frame) VALUES ('other-host:1', $1, $2) RETURNING id)
     SELECT pg_notify($3, ins.id::text || ':other-host:1') FROM ins`,
    [topic, frame, COLLAB_CHANNEL],
  );
}

describe("wiki-collab 跨进程广播", () => {
  const wikiId = `w-${shortId()}`;
  const productionId = `p-${shortId()}`;
  const received: string[] = [];
  const cancel = registerWikiSSE(wikiId, "c1", (f) => received.push(f));
  const cancelLib = registerWikiLibrarySSE(productionId, "c1", (f) => received.push(f));

  afterAll(async () => {
    cancel(); cancelLib();
    await stopCollabListenerForTests();
    await getPool().query(`DELETE FROM wiki_collab_outbox WHERE topic IN ($1, $2)`, [wikiId, `library:${productionId}`]);
  });

  it("别的进程发的 update 帧（含整篇正文，超过 NOTIFY 8KB 上限）原样到达本进程的客户端", async () => {
    const body = "正文".repeat(6000); // ~36KB
    const frame = `event: update\ndata: ${JSON.stringify({ byClientId: null, title: "t", body, updatedAt: "x" })}\n\n`;
    await publishFromOtherProcess(wikiId, frame);
    await waitFor(() => received.includes(frame));
  });

  it("别的进程发的 library 帧到达（左侧树刷新靠它）", async () => {
    const frame = `event: library\ndata: ${JSON.stringify({ kind: "created", wikiId: "n1" })}\n\n`;
    await publishFromOtherProcess(`library:${productionId}`, frame);
    await waitFor(() => received.includes(frame));
  });

  it("本进程自己 broadcast：客户端只收到一次（本地推一次，LISTEN 回声被 origin 过滤）", async () => {
    received.length = 0;
    broadcastWikiUpdate(wikiId, { byClientId: null, title: "self", body: "b", updatedAt: "now" });
    broadcastWikiLibraryChange(productionId, { kind: "updated", wikiId });
    await waitFor(() => received.length >= 2);
    await new Promise((r) => setTimeout(r, 400)); // 给回声（如果有）到达的时间
    expect(received.filter((f) => f.includes("\"self\"")).length).toBe(1);
    expect(received.filter((f) => f.includes("\"updated\"")).length).toBe(1);
    // 出站箱里确实落了行（其他进程靠它取帧），origin 是本进程
    const rows = await getPool().query(`SELECT origin FROM wiki_collab_outbox WHERE topic = $1`, [wikiId]);
    expect(rows.rows.some((r) => r.origin === COLLAB_ORIGIN)).toBe(true);
  });
});
