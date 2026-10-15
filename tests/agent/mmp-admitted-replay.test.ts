import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MmpClient } from "@mmp/client";
const state = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn(), tickets: new Map<string, Record<string, unknown>>() }));
vi.mock("@/lib/agent/runtime/admission", () => ({
  currentAdmissionScope: () => ({ runId: "r", signal: new AbortController().signal, operationKey: "tool-call" }),
  acquire: state.acquire, release: state.release,
}));
vi.mock("@/lib/agent/runtime/admission-db", () => ({ admissionRemoteId: vi.fn(), unknownMmpAdmissions: vi.fn() }));
vi.mock("@/lib/mmp/client", () => ({ getMmpClient: () => null }));
import { admittedMmpRun } from "@/lib/mmp/admitted-run";

beforeEach(() => {
  vi.clearAllMocks(); state.tickets.clear();
  state.acquire.mockImplementation(async (_runId, key) => {
    const previous = state.tickets.get(key);
    if (previous) return previous;
    const ticket = { id: key, state: "active" }; state.tickets.set(key, ticket); return ticket;
  });
  state.release.mockImplementation(async (ticket, status, result) => { Object.assign(ticket, { state: status, result }); });
});

describe("MMP 持久任务重放", () => {
  it("刷新签名地址、缓存句柄及 delivery 后仍使用同一结果，不再次提交", async () => {
    const submit = vi.fn(async () => ({ job_id: "original-job", status: "done" }));
    const client = { submit } as unknown as MmpClient;
    const first = await admittedMmpRun(client, { type: "audio.crop", arguments: { audio: { get: { url: "https://r2.test/input?signature=first" } } },
      delivery: { audio: { url: "https://r2.test/output?signature=first" } } }, {}, "attachment:input:range:10-20");
    const replay = await admittedMmpRun(client, { type: "audio.crop", arguments: { audio: { ref: "sha256:cached", get: { url: "https://r2.test/input?signature=second" } } },
      delivery: { audio: { url: "https://r2.test/output?signature=second" } } }, {}, "attachment:input:range:10-20");
    expect(submit).toHaveBeenCalledOnce(); expect(replay).toEqual(first);
  });

  it("不同区间、档位或 capability 仍是独立操作", async () => {
    const submit = vi.fn(async () => ({ job_id: "job", status: "done" }));
    const client = { submit } as unknown as MmpClient;
    for (const [type, tier, key] of [["audio.crop", "cpu", "input:10-20"], ["audio.crop", "cpu", "input:20-30"],
      ["audio.crop", "gpu", "input:10-20"], ["audio.inspect", "cpu", "input:10-20"]] as const) {
      await admittedMmpRun(client, { type, tier, arguments: {} }, {}, key);
    }
    expect(submit).toHaveBeenCalledTimes(4);
  });
});
