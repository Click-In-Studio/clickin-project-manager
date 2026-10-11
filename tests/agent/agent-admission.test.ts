import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction } from "../_support/factories";
import { newSessionId, newRunId } from "@/lib/agent/runtime/ids";
import { acquire, release, admissionLimits, runInAdmission, wrapTools, waitForInput } from "@/lib/agent/runtime/admission";
import { requestAdmission, recoverAdmissions } from "@/lib/agent/runtime/admission-db";
import type { AdmissionClass } from "@/lib/agent/runtime/admission-types";
import { PgSessionStorage } from "@/lib/agent/runtime/pg-session-storage";
import { RUNNER_OWNER } from "@/lib/agent/runtime/config";
let prodId: string; let userId: string;
const defaults = { ...admissionLimits };
beforeAll(async () => { userId=(await upsertFeishuUser(`admission-${newRunId()}`,"准入测试",null,false)).userId; const p = await makeProduction(userId); prodId=p.prodId; });
afterEach(() => { Object.assign(admissionLimits, defaults); });
afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });
async function run(kind: AdmissionClass = "interactive"): Promise<string> {
  const session = newSessionId(); const id = newRunId();
  await getPool().query("INSERT INTO agent_session(id,user_id,production_id) VALUES($1,$2,$3)", [session,userId,prodId]);
  await getPool().query("INSERT INTO agent_run(id,session_id,status,admission_class,owner,heartbeat_at) VALUES($1,$2,'running',$3,'fixture',now()+interval '1 day')", [id,session,kind]); return id;
}
async function until(fn: () => Promise<boolean>): Promise<void> {
  for (let i=0;i<100;i++) { if (await fn()) return; await new Promise((r) => setTimeout(r,20)); }
  throw new Error("未达到预期状态");
}
describe("所有来源共享资源准入", () => {
  it("LLM 已满时 MMP 与本地重工具仍可执行；超额工作排队直到释放", async () => {
    admissionLimits.llm=1;
    const a=await run(), b=await run("subagent"); const signal=new AbortController().signal;
    const first=await acquire(a,"llm:first","llm",signal);
    let started=false; const next=acquire(b,"llm:next","llm",signal).then((t) => { started=true;return t; });
    const mmp=await acquire(b,"mmp:one","mmp",signal);
    const local=await acquire(b,"local:one","local_tool",signal);
    expect(started).toBe(false);
    await release(first); const second=await next;
    await Promise.all([release(second),release(mmp),release(local)]);
  });
  it("普通对话优先于子任务和定时工作；aging 最终提升定时任务", async () => {
    admissionLimits.llm=1;
    const blocker=await acquire(await run(),"block","llm",new AbortController().signal);
    const schedule=await run("schedule"), child=await run("subagent"), interactive=await run();
    const order: string[]=[];
    const jobs=[schedule,child,interactive].map((id) => acquire(id,"queued","llm",new AbortController().signal).then(async (t) => { order.push(id);await release(t); }));
    await until(async () => (await getPool().query("SELECT id FROM agent_admission WHERE run_id=ANY($1::text[]) AND state='ready'", [[schedule,child,interactive]])).rowCount===3);
    await getPool().query("UPDATE agent_admission SET ready_at=now()-interval '30 minutes' WHERE run_id=$1", [schedule]);
    await release(blocker); await Promise.all(jobs);
    expect(order).toEqual([schedule,interactive,child]);
  });
  it("排队期间停止不执行、不泄漏名额", async () => {
    admissionLimits.context=1;
    const first=await acquire(await run(),"context","context",new AbortController().signal);
    const abort=new AbortController(); const id=await run();
    const waiting=acquire(id,"context","context",abort.signal);
    const rejection=expect(waiting).rejects.toBeDefined();
    await until(async () => (await getPool().query("SELECT 1 FROM agent_admission WHERE run_id=$1", [id])).rowCount===1);
    abort.abort(); await rejection; await release(first);
    await until(async () => (await getPool().query("SELECT state FROM agent_admission WHERE run_id=$1", [id])).rows[0]?.state==='failed');
  });
  it("状态流快照保留 queued，刷新接回不会误判为已完成", async () => {
    const id=await run();
    const row=(await getPool().query("UPDATE agent_run SET status='queued' WHERE id=$1 RETURNING session_id",[id])).rows[0];
    const {sessionRuntimeSnapshot}=await import("@/lib/agent/runtime/session-runtime-db");
    expect(await sessionRuntimeSnapshot(row.session_id)).toEqual({parentRunId:id,parentStatus:"queued"});
  });
  it("主任务等待子任务时，子任务继承优先级；并发领取不突破预算", async () => {
    const parent=await run(), child=await run("subagent"), ordinaryChild=await run("subagent");
    const sessionId=(await getPool().query("SELECT session_id FROM agent_run WHERE id=$1",[child])).rows[0].session_id;
    await getPool().query("UPDATE agent_run SET input_wait=$2::jsonb WHERE id=$1",[parent,JSON.stringify({kind:"subagent",ids:[sessionId],deadline:Date.now()+60_000})]);
    const parentTicket=await requestAdmission(parent,"parent-context","context");
    await getPool().query("UPDATE agent_admission SET state='done' WHERE id=$1",[parentTicket.id]);
    const low=await requestAdmission(ordinaryChild,"claim-low","llm"), high=await requestAdmission(child,"claim-high","llm");
    const {claimAdmissions}=await import("@/lib/agent/runtime/admission-db");
    const claims=await Promise.all([claimAdmissions("llm",1,30_000,[low.id,high.id]),claimAdmissions("llm",1,30_000,[low.id,high.id])]);
    expect(claims.flat().map((r)=>r.id)).toEqual([high.id]);
    await release(claims.flat()[0]);
    await getPool().query("DELETE FROM agent_admission WHERE id=$1",[low.id]);
    await getPool().query("UPDATE agent_run SET input_wait=NULL WHERE id=$1",[parent]);
  });
  it("恢复释放失联本地操作；远端状态未知继续占预算", async () => {
    const id=await run();
    const a=await requestAdmission(id,"orphan-llm","llm"), b=await requestAdmission(id,"orphan-mmp","mmp");
    await getPool().query("UPDATE agent_admission SET state='active',heartbeat_at=now()-interval '5 minutes' WHERE id=ANY($1::text[])", [[a.id,b.id]]);
    await recoverAdmissions(30_000);
    const rows=(await getPool().query("SELECT id,state FROM agent_admission WHERE id=ANY($1::text[])", [[a.id,b.id]])).rows;
    expect(rows.find((r) => r.id===a.id).state).toBe("failed");
    expect(rows.find((r) => r.id===b.id).state).toBe("unknown");
    await getPool().query("DELETE FROM agent_admission WHERE id=ANY($1::text[])", [[a.id,b.id]]);
  });
  it("旧执行代次的迟到结果不能修改新会话或内存树", async () => {
    const id=await run();
    const row=(await getPool().query("UPDATE agent_run SET owner=$2 WHERE id=$1 RETURNING session_id", [id,RUNNER_OWNER])).rows.find((r) => r.session_id);
    const sessionId=(await getPool().query("SELECT session_id FROM agent_run WHERE id=$1", [id])).rows[0].session_id;
    expect(row).toBeDefined();
    const storage=(await PgSessionStorage.load(sessionId))!;
    storage.bindRun(id,0);
    await getPool().query("UPDATE agent_run SET execution_epoch=1 WHERE id=$1", [id]);
    const entryId=newRunId();
    await expect(storage.appendEntry({ type:"message",id:entryId,parentId:null,timestamp:new Date().toISOString(),message:{role:"user",content:[{type:"text",text:"迟到输入"}],timestamp:Date.now()} })).rejects.toThrow("租约已失效");
    expect((await storage.getEntries()).some((e) => e.id===entryId)).toBe(false);
    expect((await getPool().query("SELECT 1 FROM agent_session_entry WHERE session_id=$1 AND entry_id=$2", [sessionId,entryId])).rowCount).toBe(0);
  });
  it("同回合有输入等待和在途工具时，先保留上下文，工具完成后才挂起", async () => {
    const id=await run();
    const sessionId=(await getPool().query("UPDATE agent_run SET owner=$2 WHERE id=$1 RETURNING session_id",[id,RUNNER_OWNER])).rows[0].session_id;
    const {createOrReuseQuestion}=await import("@/lib/agent/runtime/questions");
    const q=await createOrReuseQuestion({runId:id,sessionId,toolCallId:"mixed-input",questions:[{questionId:"q",header:"选择",question:"选哪个？",options:[{label:"甲"},{label:"乙"}]}]});
    const abort=new AbortController();let parked=0,finishWork!:()=>void;
    const inFlight=new Promise<void>(r=>{finishWork=r;});
    const tools=wrapTools([
      {mcpName:"input",name:"input",label:"input",description:"",parameters:{type:"object"},readOnly:true,execute:async()=>{
        await waitForInput(id,{kind:"question",id:q.id});
        await new Promise<void>(r=>{if(abort.signal.aborted)r();else abort.signal.addEventListener("abort",()=>r(),{once:true});});
        return {content:[],details:undefined};
      }},
      {mcpName:"work",name:"work",label:"work",description:"",parameters:{type:"object"},readOnly:true,execute:async()=>{await inFlight;return {content:[{type:"text" as const,text:"已完成"}],details:undefined};}},
    ]);
    const executing=runInAdmission(id,abort.signal,()=>{parked++;abort.abort();},async()=>{
      await Promise.all(tools.map((tool,i)=>tool.execute(`mixed-${i}`,{},abort.signal)));
    });
    try {
      await until(async()=>(await getPool().query("SELECT input_wait FROM agent_run WHERE id=$1",[id])).rows[0].input_wait?.kind==="question");
      expect(parked).toBe(0);
      finishWork();await executing;expect(parked).toBe(1);
      expect((await getPool().query("SELECT result FROM agent_tool_operation WHERE run_id=$1 AND tool_call_id='mixed-1'",[id])).rows[0].result.content).toEqual([{type:"text",text:"已完成"}]);
    }finally{finishWork();abort.abort();await executing;await getPool().query("UPDATE agent_run SET input_wait=NULL WHERE id=$1",[id]);}
  });
  it("注册点：主、子、压缩、OCR、动态能力与预检均接入实际资源边界", () => {
    for (const file of ["service.ts","subagents.ts"]) {
      const s=readFileSync(`lib/agent/runtime/${file}`,"utf8"); expect(s).toContain("admittedStream("); expect(s).toContain("runInAdmission(");
    }
    for (const file of ["ocr.ts","capability-runner.ts","attachment-preflight.ts"]) expect(readFileSync(`lib/mmp/${file}`,"utf8")).toContain("admittedMmpRun(client,");
    expect(readFileSync("lib/agent/runtime/service.ts","utf8")).toContain('"llm", signal');
  });
});
