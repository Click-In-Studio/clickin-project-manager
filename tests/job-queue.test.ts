// 后台重活任务队列（lib/job/queue.ts + run.ts）：enqueue/dedupe/认领/终局/退避/租约 sweep/
// 双模式等待/inline 形态。全部用本测试自己造的行（工厂纪律），种类名带前缀避免与真实 handler 撞。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import {
  enqueueJob, claimJobs, claimJobById, completeJob, failJob, sweepExpiredLeases,
  waitForJob, getJob, requestJobSteer, stopJobListenerForTests, TerminalJobError,
  type JobRow,
} from "@/lib/job/queue";
import { registerJobHandler } from "@/lib/job/handlers";
import { shortId } from "./factories";

const OWNER = `test:${process.pid}`;
const created: string[] = [];

/** 记录本测试创建的行，便于收尾清理。 */
async function makeJob(input: Parameters<typeof enqueueJob>[0]): Promise<JobRow> {
  const row = await enqueueJob(input);
  if (!created.includes(row.id)) created.push(row.id);
  return row;
}

/** claimJobs 可能领到并行测试留下的行：不是我们的立刻原样放回。 */
async function claimMineOnly(limit: number, opts?: { excludeKinds?: string[] }): Promise<JobRow[]> {
  const rows = await claimJobs(OWNER, limit, opts);
  const mine: JobRow[] = [];
  for (const row of rows) {
    if (created.includes(row.id)) { mine.push(row); continue; }
    await getPool().query(
      `UPDATE job SET status = 'queued', lease_owner = NULL, lease_until = NULL, attempts = attempts - 1 WHERE id = $1`,
      [row.id],
    );
  }
  return mine;
}

const savedJobWorker = process.env.JOB_WORKER;

afterAll(async () => {
  if (savedJobWorker === undefined) delete process.env.JOB_WORKER;
  else process.env.JOB_WORKER = savedJobWorker;
  await stopJobListenerForTests();
  await getPool().query(`DELETE FROM job WHERE id = ANY($1::text[])`, [created]).catch(() => {});
});

describe("queue 模式（JOB_WORKER=1：enqueue 只入队）", () => {
  beforeAll(() => { process.env.JOB_WORKER = "1"; });

  it("enqueue 入队为 queued，payload 原样", async () => {
    const row = await makeJob({ kind: `tq_${shortId()}`, payload: { a: 1 } });
    expect(row.status).toBe("queued");
    expect(row.payload).toEqual({ a: 1 });
    expect(row.attempts).toBe(0);
  });

  it("dedupe：同 key 的在途任务合流；终局后同 key 可再入队", async () => {
    const kind = `tq_${shortId()}`;
    const key = `dedupe_${shortId()}`;
    const first = await makeJob({ kind, payload: {}, dedupeKey: key });
    const second = await makeJob({ kind, payload: {}, dedupeKey: key });
    expect(second.id).toBe(first.id);
    const claimed = await claimJobById(first.id, OWNER);
    expect(claimed?.status).toBe("running");
    // running 期间仍合流
    const third = await makeJob({ kind, payload: {}, dedupeKey: key });
    expect(third.id).toBe(first.id);
    await completeJob(first.id, OWNER, { ok: true });
    const done = await getJob(first.id);
    expect(done?.status).toBe("done");
    expect(done?.result).toEqual({ ok: true });
    const fourth = await makeJob({ kind, payload: {}, dedupeKey: key });
    expect(fourth.id).not.toBe(first.id);
  });

  it("认领即 attempts+1；失败非终局退避重排、终局 failed", async () => {
    const row = await makeJob({ kind: `tq_${shortId()}`, payload: {} });
    const claimed = await claimJobById(row.id, OWNER);
    expect(claimed?.attempts).toBe(1);
    await failJob(row.id, OWNER, "瞬态失败");
    const requeued = await getJob(row.id);
    expect(requeued?.status).toBe("queued");
    expect(requeued?.error).toBe("瞬态失败");
    expect(requeued!.runAfter.getTime()).toBeGreaterThan(Date.now()); // 退避
    // 拉回 run_after 立即可领，走终局分支
    await getPool().query(`UPDATE job SET run_after = now() WHERE id = $1`, [row.id]);
    await claimJobById(row.id, OWNER);
    await failJob(row.id, OWNER, "坏文件", { terminal: true });
    const failed = await getJob(row.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("坏文件");
  });

  it("attempts 用尽后即便非终局失败也 failed", async () => {
    const row = await makeJob({ kind: `tq_${shortId()}`, payload: {}, maxAttempts: 1 });
    await claimJobById(row.id, OWNER);
    await failJob(row.id, OWNER, "又失败了");
    expect((await getJob(row.id))?.status).toBe("failed");
  });

  it("claimJobs 按 excludeKinds 排除", async () => {
    const kindA = `tqa_${shortId()}`;
    const kindB = `tqb_${shortId()}`;
    const a = await makeJob({ kind: kindA, payload: {} });
    const b = await makeJob({ kind: kindB, payload: {} });
    const firstBatch = await claimMineOnly(10, { excludeKinds: [kindA] });
    expect(firstBatch.map((j) => j.id)).toContain(b.id);
    expect(firstBatch.map((j) => j.id)).not.toContain(a.id);
    const secondBatch = await claimMineOnly(10);
    expect(secondBatch.map((j) => j.id)).toContain(a.id);
    for (const j of [...firstBatch, ...secondBatch]) await completeJob(j.id, OWNER, null);
  });

  it("waitForJob：完成时经 NOTIFY 醒来拿到终局；超时返回 null", async () => {
    const row = await makeJob({ kind: `tq_${shortId()}`, payload: {} });
    expect(await waitForJob(row.id, 50)).toBeNull(); // 没人执行 → 超时
    const wait = waitForJob(row.id, 8_000);
    setTimeout(() => {
      void claimJobById(row.id, OWNER).then(() => completeJob(row.id, OWNER, { n: 7 }));
    }, 150);
    const finished = await wait;
    expect(finished?.status).toBe("done");
    expect(finished?.result).toEqual({ n: 7 });
  });

  it("requestJobSteer 把会话 id 补进 payload、不动其余字段", async () => {
    const row = await makeJob({ kind: `tq_${shortId()}`, payload: { keep: "me" } });
    await requestJobSteer(row.id, "as_xyz");
    const after = await getJob(row.id);
    expect(after?.payload).toEqual({ keep: "me", notifySessionId: "as_xyz" });
  });

  it("sweep：过期租约可重试的重排、attempts 用尽的终局", async () => {
    const retryable = await makeJob({ kind: `tq_${shortId()}`, payload: {} });
    const exhausted = await makeJob({ kind: `tq_${shortId()}`, payload: {}, maxAttempts: 1 });
    await claimJobById(retryable.id, OWNER);
    await claimJobById(exhausted.id, OWNER);
    await getPool().query(`UPDATE job SET lease_until = now() - interval '1 minute' WHERE id = ANY($1::text[])`, [[retryable.id, exhausted.id]]);
    await sweepExpiredLeases();
    expect((await getJob(retryable.id))?.status).toBe("queued");
    expect((await getJob(exhausted.id))?.status).toBe("failed");
  });
});

describe("inline 形态（JOB_WORKER 未设：enqueue 原地执行）", () => {
  beforeAll(() => { delete process.env.JOB_WORKER; });
  afterAll(() => { process.env.JOB_WORKER = "1"; });

  it("handler 成功 → enqueue 返回即 done，带 result", async () => {
    const kind = `ti_${shortId()}`;
    registerJobHandler(kind, { run: async (payload) => ({ echoed: payload.x }) });
    const row = await makeJob({ kind, payload: { x: 42 } });
    expect(row.status).toBe("done");
    expect(row.result).toEqual({ echoed: 42 });
  });

  it("handler 抛 TerminalJobError → failed 不重试", async () => {
    const kind = `ti_${shortId()}`;
    registerJobHandler(kind, { run: async () => { throw new TerminalJobError("坏输入"); } });
    const row = await makeJob({ kind, payload: {} });
    expect(row.status).toBe("failed");
    expect(row.error).toBe("坏输入");
    expect(row.attempts).toBe(1);
  });

  it("handler 抛普通错误 → 退避重排（queued）", async () => {
    const kind = `ti_${shortId()}`;
    registerJobHandler(kind, { run: async () => { throw new Error("网络抖了"); } });
    const row = await makeJob({ kind, payload: {} });
    expect(row.status).toBe("queued");
    expect(row.error).toBe("网络抖了");
  });

  it("未注册的种类 → failed（未知任务类型）", async () => {
    const row = await makeJob({ kind: `ti_missing_${shortId()}`, payload: {} });
    expect(row.status).toBe("failed");
    expect(row.error).toContain("未知任务类型");
  });
});
