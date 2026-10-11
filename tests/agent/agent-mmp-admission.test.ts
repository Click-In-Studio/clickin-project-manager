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
const job = { type: "ocr.structured", media: media.get("https://example.invalid/page.png") } as Parameters<MmpClient["run"]>[0];
function fake() {
  const done={ job_id: "remote-test", status: "done", type: job.type, cached: false, media_id: "media-test", result: { text: "识别结果" }, source: { tier: "cpu",engine:"test",engine_version:"1",degraded:false } };
  const submit=vi.fn(async () => ({ job_id: "remote-test",status:"queued" }));
  const get=vi.fn(async () => done);
  const cancel=vi.fn(async () => ({ job_id:"remote-test",status:"cancelled" }));
  return { client: { submit,get,cancel } as unknown as MmpClient,submit,get,cancel,done };
}
describe("MMP 持久操作与取消", () => {
  it("恢复使用原 job 身份和已保存结果，不再次提交或重复执行工具", async () => {
    const id=await run(), f=fake(); const abort=new AbortController();
    const execute=vi.fn(async () => ({ content:[{type:"text" as const,text:await admittedMmpRun(f.client,job,{},"file-1").then((r)=>JSON.stringify(r.result))}],details:undefined }));
    const tool=wrapTools([{ mcpName:"test",name:"test",label:"test",description:"test",parameters:{type:"object"},readOnly:true,execute }])[0];
    const first=await runInAdmission(id,abort.signal,()=>{},()=>tool.execute("call-1",{},abort.signal));
    const restored=await runInAdmission(id,abort.signal,()=>{},()=>tool.execute("call-1",{},abort.signal));
    expect(restored).toEqual(first); expect(execute).toHaveBeenCalledTimes(1); expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.get).toHaveBeenCalledWith("remote-test",expect.any(Number));
  });
  it("取消未确认保持占用，查到远程终态后才释放", async () => {
    admissionLimits.mmp=1;
    const id=await run(), f=fake(), abort=new AbortController();
    f.get.mockImplementationOnce(async () => { abort.abort(); return {job_id:"remote-test",status:"running"} as typeof f.done; });
    f.cancel.mockImplementationOnce(async () => ({job_id:"remote-test",status:"running"}));
    await expect(runInAdmission(id,abort.signal,()=>{},()=>admittedMmpRun(f.client,job,{},"file-2"))).rejects.toBeDefined();
    const row=(await getPool().query("SELECT state,remote_id FROM agent_admission WHERE run_id=$1 AND resource='mmp'", [id])).rows[0];
    expect(row).toEqual({state:"unknown",remote_id:"remote-test"}); expect(f.cancel).toHaveBeenCalledTimes(1);
    await reconcileMmpAdmissions(f.client);
    expect((await getPool().query("SELECT state FROM agent_admission WHERE run_id=$1", [id])).rows[0].state).toBe("done");
  });
  it("提交响应丢失且无 job_id 时，不盲目再提交", async () => {
    const id=await run(), f=fake(), signal=new AbortController().signal;
    f.submit.mockRejectedValue(new MmpError("network","响应丢失"));
    await expect(runInAdmission(id,signal,()=>{},()=>admittedMmpRun(f.client,job,{},"file-3"))).rejects.toBeDefined();
    await expect(runInAdmission(id,signal,()=>{},()=>admittedMmpRun(f.client,job,{},"file-3"))).rejects.toThrow("执行状态未确认");
    expect(f.submit).toHaveBeenCalledTimes(1);
    const ticket=(await getPool().query("SELECT state,remote_id FROM agent_admission WHERE run_id=$1", [id])).rows[0];
    expect(ticket).toEqual({state:"unknown",remote_id:null});
    await getPool().query("DELETE FROM agent_admission WHERE run_id=$1", [id]);
  });
});
