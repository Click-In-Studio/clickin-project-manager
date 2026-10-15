import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { newRunId, newSessionId } from "@/lib/agent/runtime/ids";
import { RUNNER_OWNER, resolveModel } from "@/lib/agent/runtime/config";
import { contextRepeatsWithoutProgress, estimateCostBudget, repeatsWithoutProgress, toolProgressKey, TASK_COST_LIMIT_CREDITS } from "@/lib/agent/runtime/cost-budget";
import { reserveRequestCost, settleRequestCost, assertToolProgress } from "@/lib/agent/runtime/cost-budget-db";
import { requestAdmission, reattachAdmission, beginToolOperation, saveToolResult, saveToolFailure } from "@/lib/agent/runtime/admission-db";
import type { Context } from "../../vendor/openclaw/packages/llm-core/src/types";
import { PgSessionStorage } from "@/lib/agent/runtime/pg-session-storage";
import { Session } from "../../vendor/openclaw/packages/agent-core/src/harness/session/session";

let prodId: string; let userId: string;
beforeAll(async () => {
  userId = (await upsertFeishuUser(`budget-${shortId()}`, "预算测试", null, false)).userId;
  prodId = (await makeProduction(userId)).prodId;
});
afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });
async function run(parent?: string) {
  const sessionId = newSessionId(); const id = newRunId();
  await getPool().query("INSERT INTO agent_session(id,user_id,production_id) VALUES($1,$2,$3)", [sessionId,userId,prodId]);
  await getPool().query("INSERT INTO agent_run(id,session_id,status,owner,budget_run_id) VALUES($1,$2,'running',$3,$4)", [id,sessionId,RUNNER_OWNER,parent ?? null]);
  const ticket = await requestAdmission(id, "llm:test", "llm");
  await reattachAdmission(ticket.id);
  return { id, sessionId, ticketId: ticket.id };
}
const context = (characters: number): Context => ({ messages: [{ role: "user", content: "文".repeat(characters), timestamp: 0 }] });

describe("任务预算与循环检测分离", () => {
  it("26 万 token 冷缓存的两次正常往返不受旧 50 万 credit 阈值限制", async () => {
    const model = resolveModel("inspiration"); const estimate = estimateCostBudget(model, context(266000));
    expect(estimate.taskCredits).toBeGreaterThan(estimate.requestCredits * 2);
    const r = await run();
    await reserveRequestCost(r.id, r.ticketId, estimate.requestCredits, estimate.taskCredits);
    await settleRequestCost(r.id, r.ticketId, 454750);
    await reserveRequestCost(r.id, r.ticketId, estimate.requestCredits, estimate.taskCredits);
    await settleRequestCost(r.id, r.ticketId, 51354);
    const row = (await getPool().query("SELECT task_credits FROM agent_run WHERE id=$1", [r.id])).rows[0];
    expect(Number(row.task_credits)).toBe(506104);
  });
  it("预算随模型和上下文成本变化，并受最终上限约束", () => {
    const cheap = estimateCostBudget(resolveModel("resonance"), context(10000));
    const costly = estimateCostBudget(resolveModel("inspiration"), context(266000));
    expect(costly.taskCredits).toBeGreaterThan(cheap.taskCredits);
    expect(estimateCostBudget(resolveModel("inspiration"), context(1000000)).taskCredits).toBe(TASK_COST_LIMIT_CREDITS);
  });
  it("并发子任务原子预留同一份根预算；结算一次后释放余额", async () => {
    const root = await run(); const children = await Promise.all([run(root.id), run(root.id)]);
    const requests = await Promise.allSettled(children.map(c => reserveRequestCost(c.id,c.ticketId,300000,500000)));
    expect(requests.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const winner = children[requests.findIndex(r => r.status === "fulfilled")];
    const loser = children[requests.findIndex(r => r.status === "rejected")];
    await Promise.all([settleRequestCost(winner.id,winner.ticketId,100000),settleRequestCost(winner.id,winner.ticketId,100000)]);
    await reserveRequestCost(loser.id,loser.ticketId,300000,500000);
    expect(Number((await getPool().query("SELECT task_credits FROM agent_run WHERE id=$1", [root.id])).rows[0].task_credits)).toBe(100000);
  });
  it("恢复重试保守计算未知请求，且已结算结果不重复扣成本", async () => {
    const r = await run();
    await reserveRequestCost(r.id,r.ticketId,100000,500000);
    await getPool().query("UPDATE agent_admission SET owner='old',state='failed' WHERE id=$1", [r.ticketId]);
    await reattachAdmission(r.ticketId);
    await reserveRequestCost(r.id,r.ticketId,100000,500000);
    await settleRequestCost(r.id,r.ticketId,50000);
    await settleRequestCost(r.id,r.ticketId,50000);
    expect(Number((await getPool().query("SELECT task_credits FROM agent_run WHERE id=$1", [r.id])).rows[0].task_credits)).toBe(150000);
  });
  it("旧执行者不能预留或结算新执行者的请求", async () => {
    const r = await run(); await reserveRequestCost(r.id,r.ticketId,100000,500000);
    await getPool().query("UPDATE agent_admission SET owner='new' WHERE id=$1", [r.ticketId]);
    await expect(reserveRequestCost(r.id,r.ticketId,100000,500000)).rejects.toThrow("租约");
    await settleRequestCost(r.id,r.ticketId,100000);
    expect(Number((await getPool().query("SELECT task_credits FROM agent_run WHERE id=$1", [r.id])).rows[0].task_credits)).toBe(0);
  });
  it("预算不足拒绝下一请求，但已完成工具保留；不设置 abort", async () => {
    const r = await run();
    await getPool().query("UPDATE agent_run SET task_credits=$2 WHERE id=$1", [r.id,TASK_COST_LIMIT_CREDITS]);
    await expect(reserveRequestCost(r.id,r.ticketId,1,TASK_COST_LIMIT_CREDITS)).rejects.toThrow("task-budget-exceeded");
    expect((await getPool().query("SELECT status FROM agent_run WHERE id=$1", [r.id])).rows[0].status).toBe("running");
  });
  it("参数键序不影响摘要，分页或结果变化属于进展", () => {
    expect(toolProgressKey("read", { a: 1,b: 2 },"结果")).toBe(toolProgressKey("read", { b: 2,a: 1 },"结果"));
    expect(toolProgressKey("read",{}, { content: [],details: { elapsed: 1 } })).toBe(toolProgressKey("read",{}, { content: [],details: { elapsed: 2 } }));
    expect(repeatsWithoutProgress(["a","a","a"])).toBe(false);
    expect(repeatsWithoutProgress(["a","a","a","a"])).toBe(true);
    expect(repeatsWithoutProgress(["a","b","a","b","a","b"])).toBe(true);
    expect(repeatsWithoutProgress(["a","a","a","new"])).toBe(false);
    expect(repeatsWithoutProgress([0,1,2,3,4,5].map(offset => toolProgressKey("read",{offset},"内容")))).toBe(false);
    expect(repeatsWithoutProgress([0,1,2,3].map(state => toolProgressKey("poll",{},state)))).toBe(false);
  });
  it("循环记录跨恢复保留；新用户输入重置范围", async () => {
    const r = await run();
    const storage = (await PgSessionStorage.load(r.sessionId))!; storage.bindRun(r.id,0);
    const session = new Session(storage);
    await session.appendMessage({ role: "user", content: "检查",timestamp: 0 });
    for (let index = 0; index < 4; index++) {
      const callId = `call-${index}`;
      await beginToolOperation(r.id,callId);
      await saveToolResult(r.id,callId,{ content: [{ type: "text",text: "相同结果" }] },"read",{ id: "same" });
    }
    await expect(assertToolProgress(r.id)).rejects.toThrow("tool-loop-detected");
    await getPool().query("UPDATE agent_run SET execution_epoch=execution_epoch+1 WHERE id=$1", [r.id]);
    await expect(assertToolProgress(r.id)).rejects.toThrow("tool-loop-detected");
    storage.bindRun(r.id,1);
    await session.appendMessage({ role: "user",content: "再次核对",timestamp: 1 });
    await expect(assertToolProgress(r.id)).resolves.toBeUndefined();
  });
  it("重复相同工具错误也会累计循环证据，不因 execute 抛错而绕过检测", async () => {
    const r = await run();
    const storage = (await PgSessionStorage.load(r.sessionId))!; storage.bindRun(r.id,0);
    await new Session(storage).appendMessage({ role: "user",content: "检查",timestamp: 0 });
    for (let i = 0; i < 4; i++) {
      await beginToolOperation(r.id,`error-${i}`);
      await saveToolFailure(r.id,`error-${i}`,"read",{},new Error("同一错误"));
    }
    await expect(assertToolProgress(r.id)).rejects.toThrow("tool-loop-detected");
  });
  it("未进入 execute 的权限拒绝或参数错误仍能检测重复循环", () => {
    const model = resolveModel("inspiration");
    const messages: Context["messages"] = [{ role: "user",content: "核对",timestamp: 0 }];
    for (let i = 0; i < 4; i++) {
      messages.push({ role: "assistant",api: model.api,provider: model.provider,model: model.id,content: [{ type: "toolCall",id: `denied-${i}`,name: "read",arguments: {} }],stopReason: "toolUse",timestamp: 0,usage: { input: 0,output: 0,cacheRead: 0,cacheWrite: 0,totalTokens: 0,cost: { input: 0,output: 0,cacheRead: 0,cacheWrite: 0,total: 0 } } });
      messages.push({ role: "toolResult",toolCallId: `denied-${i}`,toolName: "read",content: [{ type: "text",text: "权限不足" }],isError: true,timestamp: 0 });
    }
    expect(contextRepeatsWithoutProgress(messages)).toBe(true);
    messages.push({ role: "user",content: "重新检查",timestamp: 1 });
    expect(contextRepeatsWithoutProgress(messages)).toBe(false);
  });
  it("模型和压缩接入同一预留边界，旧成本中途 abort 路径已删除", () => {
    const admission = readFileSync("lib/agent/runtime/admission.ts","utf8");
    const compaction = readFileSync("lib/agent/runtime/request-compaction.ts","utf8");
    expect(admission).toContain("await assertToolProgress(scope.runId, context)");
    expect(admission).toContain("await reserveRequestCost(scope.runId, ticket.id");
    expect(admission).toContain("await settleRequestCost(scope.runId, ticket.id");
    expect(compaction).toContain("await budgetedComplete(model, request, summaryOptions");
    for (const path of ["service.ts","subagents.ts"]) expect(readFileSync(`lib/agent/runtime/${path}`,"utf8")).not.toMatch(/costCapAborted|costExceeded|RUN_CREDIT_HARD_CAP/);
  });
});
