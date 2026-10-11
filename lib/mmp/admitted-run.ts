import { createHash } from "node:crypto";
import { MmpError, type MmpClient } from "@mmp/client";
import { acquire, currentAdmissionScope, release } from "@/lib/agent/runtime/admission";
import { admissionRemoteId, unknownMmpAdmissions } from "@/lib/agent/runtime/admission-db";
import { getMmpClient } from "./client";
import type { AdmissionTicket } from "@/lib/agent/runtime/admission-types";

type Job = Parameters<MmpClient["run"]>[0];
type Options = NonNullable<Parameters<MmpClient["run"]>[1]>;

/** Agent 操作拆分提交/等待并保存远程身份；非 Agent 调用继续使用 MMP 自己的调度。 */
export async function admittedMmpRun(client: MmpClient, job: Job, opts: Options, fileId: string): ReturnType<MmpClient["run"]> {
  const scope = currentAdmissionScope();
  if (!scope) return client.run(job, opts);
  const digest = createHash("sha256").update(JSON.stringify([fileId, job.type, job.tier, job.params])).digest("hex");
  const key = `${scope.operationKey ?? "preflight"}:mmp:${digest}`;
  const ticket = await acquire(scope.runId, key, "mmp", scope.signal);
  if (ticket.state === "done") return ticket.result as Awaited<ReturnType<MmpClient["run"]>>;
  let remoteId = ticket.remote_id;
  let accepted = Boolean(remoteId);
  let submitted = accepted;
  try {
    if (!remoteId) {
      scope.signal.throwIfAborted();
      // 不在提交响应内长等：尽早取得可恢复的 job_id。
      submitted = true;
      const first = await client.submit({ ...job, wait: 0 });
      remoteId = first.job_id;
      accepted = true;
      await admissionRemoteId(ticket.id, remoteId);
      if (first.status === "done") { await release(ticket, "done", first); return first; }
      if (first.status === "cancelled") throw new MmpError("unexpected", "远程任务已取消", { jobId: remoteId });
    }
    const deadline = (ticket.started_at?.getTime() ?? Date.now()) + (opts.timeoutMs ?? 600_000);
    while (true) {
      scope.signal.throwIfAborted();
      if (Date.now() >= deadline) throw new MmpError("timeout", "远程任务等待超时", { jobId: remoteId });
      const result = await client.get(remoteId, Math.min(opts.pollWaitSec ?? 30, Math.ceil((deadline-Date.now())/1000)));
      if (result.status === "done") { await release(ticket, "done", result); return result; }
      if (result.status === "cancelled") { await release(ticket, "failed"); throw new MmpError("unexpected", "远程任务已取消", { jobId: remoteId }); }
    }
  } catch (e) {
    const failedJob = e instanceof MmpError && Boolean(e.jobId) && !e.retryable && e.code !== "timeout" && e.code !== "network";
    if (failedJob) await release(ticket, "failed");
    else if (remoteId && (scope.signal.aborted || e instanceof MmpError && e.code === "timeout")) await cancelRemote(client, ticket, remoteId);
    else {
      // 提交是否被接受不确定时保留名额；无 job_id 时不得盲目再次提交。
      const rejected = !submitted || !accepted && e instanceof MmpError && e.code !== "network" && e.code !== "timeout";
      await release(ticket, rejected ? "failed" : "unknown");
    }
    throw e;
  }
}

async function cancelRemote(client: MmpClient, ticket: AdmissionTicket, remoteId: string): Promise<void> {
  try {
    const result = await client.cancel(remoteId, 0);
    if (result.status === "done") await release(ticket, "done", result);
    else if (result.status === "cancelled") await release(ticket, "failed");
    else await release(ticket, "unknown");
  } catch { await release(ticket, "unknown"); }
}

/** 不确定但已知身份的任务按原 job 查询；取消尚未完成时继续占用名额。 */
export async function reconcileMmpAdmissions(client = getMmpClient()): Promise<void> {
  if (!client) return;
  const tickets = await unknownMmpAdmissions();
  for (const ticket of tickets) {
    try {
      const result = ticket.run_status === "aborted" ? await client.cancel(ticket.remote_id!,0) : await client.get(ticket.remote_id!,0);
      if (result.status === "done") await release(ticket,"done",result);
      else if (result.status === "cancelled") await release(ticket,"failed");
    } catch (e) {
      if (e instanceof MmpError && e.jobId && !e.retryable && e.code!=="timeout" && e.code!=="network") await release(ticket,"failed");
    }
  }
}
