import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool, poolConfigFromEnv } from "@/lib/pg";
import { Pool } from "pg";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { PgSessionStorage } from "@/lib/agent/runtime/pg-session-storage";
import type { MessageEntry } from "../../vendor/openclaw/packages/agent-core/src/harness/types";
import type { ToolResultMessage } from "../../vendor/openclaw/packages/llm-core/src/types";
import { shortId } from "../_support/factories";

// #685：工具结果被数据库以「数据非法」拒绝（jsonb 不收 \u0000 → 22P05）时，那是这一次
// tool call 的失败，不是 run 的失败。存储层把条目就地改写成 isError 的工具结果再落库，
// 模型下一轮如实看到「结果写不进去、已丢弃」，run 继续。其他条目类型仍按原样抛出。

const NUL = String.fromCharCode(0);

describe("PgSessionStorage：落库被拒 → 改写为工具失败（#685）", () => {
  let userId: string;
  const sessionId = `clickin:chat:test:${shortId()}`;
  let storage: PgSessionStorage;

  beforeAll(async () => {
    userId = (await upsertFeishuUser(`test-open-${shortId()}`, `存储拒绝-${shortId()}`, null, false)).userId;
    storage = await PgSessionStorage.create({ id: sessionId, userId, productionId: null });
  });
  afterAll(async () => {
    await getPool().query(`DELETE FROM agent_session_entry WHERE session_id = $1`, [sessionId]).catch(() => {});
    await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [sessionId]).catch(() => {});
  });

  const toolResultEntry = async (text: string): Promise<MessageEntry & { message: ToolResultMessage }> => ({
    type: "message",
    id: await storage.createEntryId(),
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult", toolCallId: `call_${shortId()}`, toolName: "clickin__web-fetch",
      content: [{ type: "text", text }], details: { raw: text }, isError: false, timestamp: Date.now(),
    },
  });

  it("含 NUL 的工具结果：不抛、就地改写为 isError、落库的是改写后的内容", async () => {
    const entry = await toolResultEntry(`%PDF-1.7${NUL}${NUL}garbage`);
    await expect(storage.appendEntry(entry)).resolves.toBeUndefined();
    // 就地改写：agent-loop 手里的同一个对象也变成失败结果
    expect(entry.message.isError).toBe(true);
    expect(entry.message.details).toBeUndefined();
    const text = (entry.message.content[0] as { text: string }).text;
    expect(text).toContain("数据库拒绝");
    expect(text).toContain("unsupported Unicode escape sequence");
    expect(text).not.toContain(NUL);
    // 库里也是改写后的那份
    const row = await getPool().query<{ payload: MessageEntry }>(
      `SELECT payload FROM agent_session_entry WHERE session_id = $1 AND entry_id = $2`, [sessionId, entry.id],
    );
    expect((row.rows[0].payload.message as ToolResultMessage).isError).toBe(true);
    expect(JSON.stringify(row.rows[0].payload)).toContain("数据库拒绝");
  });

  it("正常的工具结果原样落库，不被误改", async () => {
    const entry = await toolResultEntry("标题：正常页面\n正文");
    await storage.appendEntry(entry);
    expect(entry.message.isError).toBe(false);
    expect(entry.message.details).toEqual({ raw: "标题：正常页面\n正文" });
  });

  it("非工具结果条目（assistant）含 NUL 仍按原样抛出——改写只针对 tool call", async () => {
    const entry: MessageEntry = {
      type: "message",
      id: await storage.createEntryId(),
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant", api: "openai-completions", provider: "test", model: "test", stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: "text", text: `a${NUL}b` }], timestamp: Date.now(),
      } as MessageEntry["message"],
    };
    await expect(storage.appendEntry(entry)).rejects.toMatchObject({ code: "22P05" });
  });
  it("系统事件同连接落库，单连接池也能提交；回滚不污染内存上下文", async () => {
    const key=`clickin:chat:test:${shortId()}`;
    const pool=new Pool({...poolConfigFromEnv(),max:1,connectionTimeoutMillis:300});
    const isolated=await PgSessionStorage.create({id:key,userId,productionId:null},pool);
    const client=await pool.connect();
    const entry={type:"custom_message" as const,id:`ain_${shortId()}`,parentId:null,timestamp:new Date().toISOString(),customType:"clickin_subagent_event",display:false,content:"子任务已完成"};
    try {
      await client.query("BEGIN");
      await isolated.persistSystemEvent(entry,client);
      expect(await isolated.getEntries()).toHaveLength(0);
      await client.query("ROLLBACK");
      expect((await client.query("SELECT entry_id FROM agent_session_entry WHERE session_id=$1",[key])).rowCount).toBe(0);
      await client.query("BEGIN");
      const recordCommitted=await isolated.persistSystemEvent(entry,client);
      await client.query("COMMIT");
      recordCommitted();
      expect((await isolated.getEntries()).map((e)=>e.id)).toEqual([entry.id]);
    } finally {
      await client.query("ROLLBACK").catch(()=>{});
      client.release();
      await pool.end();
      await getPool().query("DELETE FROM agent_session WHERE id=$1",[key]);
    }
  });

});
