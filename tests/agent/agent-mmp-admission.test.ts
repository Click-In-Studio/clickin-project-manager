import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { MmpError, media, type MmpClient } from "@mmp/client";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { makeProduction, cleanupProduction } from "../_support/factories";
import { newRunId, newSessionId } from "@/lib/agent/runtime/ids";
import { RUNNER_OWNER } from "@/lib/agent/runtime/config";
import { runInAdmission, admissionLimits, wrapTools } from "@/lib/agent/runtime/admission";
import { admittedMmpRun, reconcileMmpAdmissions } from "@/lib/mmp/admitted-run";
let prodId: string; let userId: string;
const defaults = { ...admissionLimits };
beforeAll(async () => {
  userId=(await upsertFeishuUser(`mmp-admission-${newRunId()}`,"远程准入测试",null,false)).userId;
  ({prodId}=await makeProduction(userId));
});
afterEach(() => Object.assign(admissionLimits,defaults));
afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });
async function run(): Promise<string> {
  const session=newSessionId(), id=newRunId();
  await getPool().query("INSERT INTO agent_session(id,user_id,production_id) VALUES($1,$2,$3)", [session,userId,prodId]);
  await getPool().query("INSERT INTO agent_run(id,session_id,status,owner,heartbeat_at) VALUES($1,$2,'running',$3,now()+interval '1 day')", [id,session,RUNNER_OWNER]);
  return id;
}
const job = { type: "ocr.structured", arguments: { media: media.get("https://example.invalid/page.png") } } satisfies Parameters<MmpClient["run"]>[0];
function fake() {
  const done={ job_id: "remote-test", status: "done", type: job.type, cached: false, media_ids: { media: "media-test" }, outputs: { document: { kind: "json", value: { text: "识别结果" } } }, source: { tier: "cpu",engine:"test",engine_version:"1",generated_at:"2026-10-13T00:00:00Z",degraded:false } };
  const submit=vi.fn(async () => ({ job_id: "remote-test",status:"queued" }));
  const get=vi.fn(async () => done);
  const cancel=vi.fn(async () => ({ job_id:"remote-test",status:"cancelled" }));
  return { client: { submit,get,cancel } as unknown as MmpClient,submit,get,cancel,done };
}
describe("MMP 持久操作与取消", () => {
  it("恢复使用原 job 身份和已保存结果，不再次提交或重复执行工具", async () => {
    const id=await run(), f=fake(); const abort=new AbortController();
    const execute=vi.fn(async () => ({ content:[{type:"text" as const,text:await admittedMmpRun(f.client,job,{},"file-1").then((r)=>JSON.stringify(r.outputs))}],details:undefined }));
    const tool=wrapTools([{ mcpName:"test",name:"test",label:"test",description:"test",parameters:{type:"object"},readOnly:true,execute }])[0];
    const first=await runInAdmission(id,abort.signal,()=>{},()=>tool.execute("call-1",{},abort.signal));
    const restored=await runInAdmission(id,abort.signal,()=>{},()=>tool.execute("call-1",{},abort.signal));
    expect(restored).toEqual(first); expect(execute).toHaveBeenCalledTimes(1); expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.get).toHaveBeenCalledWith("remote-test",expect.any(Number));
  });
  it("取消未确认保持占用，查到远程终态后才释放", async () => {
    // 测试库可能保留其他用例故意制造的 unknown 远端任务；本例只验证自身终态收敛。
    admissionLimits.mmp=100;
    const id=await run(), f=fake(), abort=new AbortController();
    f.get.mockImplementationOnce(async () => { abort.abort(); return {job_id:"remote-test",status:"running"} as typeof f.done; });
    f.cancel.mockImplementationOnce(async () => ({job_id:"remote-test",status:"running"}));
    await expect(runInAdmission(id,abort.signal,()=>{},()=>admittedMmpRun(f.client,job,{},"file-2"))).rejects.toBeDefined();
    const row=(await getPool().query("SELECT state,remote_id FROM agent_admission WHERE run_id=$1 AND resource='mmp'", [id])).rows[0];
    expect(row).toEqual({state:"unknown",remote_id:"remote-test"}); expect(f.cancel).toHaveBeenCalledTimes(1);
    await reconcileMmpAdmissions(f.client);
    expect((await getPool().query("SELECT state FROM agent_admission WHERE run_id=$1", [id])).rows[0].state).toBe("done");
  });
  it("提交响应丢失且无 job_id 时不盲目再提交；父 run 终止并超过总超时后释放名额", async () => {
    const id=await run(), f=fake(), signal=new AbortController().signal;
    f.submit.mockRejectedValue(new MmpError("network","响应丢失"));
    await expect(runInAdmission(id,signal,()=>{},()=>admittedMmpRun(f.client,job,{},"file-3"))).rejects.toBeDefined();
    await expect(runInAdmission(id,signal,()=>{},()=>admittedMmpRun(f.client,job,{},"file-3"))).rejects.toThrow("执行状态未确认");
    expect(f.submit).toHaveBeenCalledTimes(1);
    const ticket=(await getPool().query("SELECT state,remote_id FROM agent_admission WHERE run_id=$1", [id])).rows[0];
    expect(ticket).toEqual({state:"unknown",remote_id:null});
    await getPool().query("UPDATE agent_run SET status='failed',ended_at=now() WHERE id=$1",[id]);
    await getPool().query("UPDATE agent_admission SET started_at=now()-interval '11 minutes' WHERE run_id=$1 AND resource='mmp'",[id]);
    await reconcileMmpAdmissions(f.client);
    expect((await getPool().query("SELECT state FROM agent_admission WHERE run_id=$1",[id])).rows[0].state).toBe("failed");
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.get).not.toHaveBeenCalled();
  });
  it("失联任务已知 job_id 时，主任务停止后的对账继续请求远端取消并等待确认", async () => {
    const id=await run(),f=fake(),signal=new AbortController().signal;
    f.get.mockRejectedValueOnce(new MmpError("network","轮询失联",{jobId:"remote-test"}));
    await expect(runInAdmission(id,signal,()=>{},()=>admittedMmpRun(f.client,job,{},"file-4"))).rejects.toBeDefined();
    await getPool().query("UPDATE agent_run SET status='aborted' WHERE id=$1",[id]);
    f.cancel.mockImplementationOnce(async()=>({job_id:"remote-test",status:"running"}));
    await reconcileMmpAdmissions(f.client);
    expect((await getPool().query("SELECT state FROM agent_admission WHERE run_id=$1",[id])).rows[0].state).toBe("unknown");
    await reconcileMmpAdmissions(f.client);
    expect((await getPool().query("SELECT state FROM agent_admission WHERE run_id=$1",[id])).rows[0].state).toBe("failed");
    expect(f.cancel).toHaveBeenCalledTimes(2);expect(f.get).toHaveBeenCalledTimes(1);
  });
});
