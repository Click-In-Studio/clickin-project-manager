import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BASE_PATH } from "@/lib/base-path";
import {
  patchCue, fetchListCues, createCue, deleteCueRemote,
  fetchCueListAccess, selfConfirmCueListAccess,
  fetchCueListCollaborators, addCueListCollaborator, removeCueListCollaborator,
  fetchCueComments, postCueComment, patchCueComment, deleteCueComment,
  postCuePresence, startCueExport,
} from "@/lib/ops/cue-client";

/**
 * cue 页浏览器端 client（#487 C4 从 CuePage 及其族目录里的 fetch 收拢）。钉两件事：
 * 每个函数打的 URL / method / body / credentials 与搬出前逐字一致；成功与失败分支的返回值
 * 形状（null / false / [] / 409 带 error）就是原来各处 `res.ok` 分支的语义。
 */
const P = "p_x"; const L = "l_1"; const C = "c_9";
const fetchMock = vi.fn();
function respond(status: number, json?: unknown) {
  fetchMock.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => json, body: {}, text: async () => "" });
}
const lastCall = () => fetchMock.mock.calls.at(-1) as [string, RequestInit | undefined];

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("cue CRUD", () => {
  it("patchCue：带版本参数的 PATCH；ok / 409 带 error / 其他状态", async () => {
    respond(200);
    expect(await patchCue(P, L, C, "v1", { name: "n" })).toEqual({ ok: true });
    expect(lastCall()[0]).toBe(`${BASE_PATH}/api/production/${P}/cuelists/${L}/cues/${C}?v=v1`);
    expect(lastCall()[1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ name: "n" }) });
    respond(409, { error: "被拒" });
    expect(await patchCue(P, L, C, null, { name: "n" })).toEqual({ ok: false, status: 409, error: "被拒" });
    expect(lastCall()[0]).toBe(`${BASE_PATH}/api/production/${P}/cuelists/${L}/cues/${C}`);
    respond(500);
    expect(await patchCue(P, L, C, undefined, {})).toEqual({ ok: false, status: 500 });
  });

  it("fetchListCues：非 ok 与网络错都按空表", async () => {
    respond(200, [{ id: "a" }]);
    expect(await fetchListCues(P, L, "v2")).toEqual([{ id: "a" }]);
    expect(lastCall()[0]).toBe(`${BASE_PATH}/api/production/${P}/cuelists/${L}/cues?v=v2`);
    respond(403);
    expect(await fetchListCues(P, L, null)).toEqual([]);
    fetchMock.mockRejectedValueOnce(new Error("net"));
    expect(await fetchListCues(P, L, null)).toEqual([]);
  });

  it("createCue 回整表或 null；deleteCueRemote 回 ok", async () => {
    const body = { number: "1", name: "", content: "", start: { kind: "gap" as const, afterBlockId: null }, end: { kind: "gap" as const, afterBlockId: null } };
    respond(201, [{ id: "new" }]);
    expect(await createCue(P, L, null, body)).toEqual([{ id: "new" }]);
    expect(lastCall()[1]).toMatchObject({ method: "POST", body: JSON.stringify(body) });
    respond(409);
    expect(await createCue(P, L, null, body)).toBe(null);
    respond(204);
    expect(await deleteCueRemote(P, L, C, "v3")).toBe(true);
    expect(lastCall()).toEqual([`${BASE_PATH}/api/production/${P}/cuelists/${L}/cues/${C}?v=v3`, { method: "DELETE" }]);
  });
});

describe("cue 表访问与协作者", () => {
  it("access：GET 带 credentials；自确认 POST 带 action/level", async () => {
    respond(200, { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "edit" });
    expect(await fetchCueListAccess(P, L)).toEqual({ canAccess: false, canSelfConfirm: true, selfConfirmLevel: "edit" });
    expect(lastCall()).toEqual([`${BASE_PATH}/api/production/${P}/cuelists/${L}/access`, { credentials: "include" }]);
    respond(500);
    expect(await fetchCueListAccess(P, L)).toBe(null);
    respond(200);
    expect(await selfConfirmCueListAccess(P, L, "manage")).toBe(true);
    expect(lastCall()[1]).toMatchObject({ method: "POST", credentials: "include", body: JSON.stringify({ action: "self_confirm", level: "manage" }) });
  });

  it("collaborators：GET 含 productionDepts；POST / DELETE 带 body 与 credentials，失败为 null", async () => {
    const full = { grants: [], deptAccess: [], productionDepts: [{ id: "d", name: "灯光" }] };
    respond(200, full);
    expect(await fetchCueListCollaborators(P, L)).toEqual(full);
    expect(lastCall()[0]).toBe(`${BASE_PATH}/api/production/${P}/cuelists/${L}/collaborators`);
    respond(200, { grants: [{ userId: "u" }], deptAccess: [] });
    expect(await addCueListCollaborator(P, L, { userId: "u" })).toEqual({ grants: [{ userId: "u" }], deptAccess: [] });
    expect(lastCall()[1]).toMatchObject({ method: "POST", credentials: "include", body: JSON.stringify({ userId: "u" }) });
    respond(403);
    expect(await removeCueListCollaborator(P, L, { userId: "u" })).toBe(null);
    expect(lastCall()[1]).toMatchObject({ method: "DELETE" });
  });
});

describe("评论 / 在场 / 导出", () => {
  it("评论四件：信封字段 comments / comment；失败 null / false", async () => {
    respond(200, { comments: [{ id: "c1" }] });
    expect(await fetchCueComments(P)).toEqual([{ id: "c1" }]);
    respond(200, {});
    expect(await fetchCueComments(P)).toBe(null);
    respond(200, { comment: { id: "c2" } });
    expect(await postCueComment(P, { cueId: C, body: "hi", parentId: null, mentions: [] })).toEqual({ id: "c2" });
    expect(lastCall()[1]).toMatchObject({ method: "POST", body: JSON.stringify({ cueId: C, body: "hi", parentId: null, mentions: [] }) });
    respond(200, { comment: { id: "c2", body: "edited" } });
    expect(await patchCueComment(P, "c2", "edited")).toEqual({ id: "c2", body: "edited" });
    expect(lastCall()).toEqual([`${BASE_PATH}/api/production/${P}/cue-comments/c2`, expect.objectContaining({ method: "PATCH", body: JSON.stringify({ body: "edited" }) })]);
    respond(404);
    expect(await deleteCueComment(P, "c2")).toBe(false);
  });

  it("在场上报 fire-and-forget，网络错不抛；导出直接交回 Response", async () => {
    fetchMock.mockRejectedValueOnce(new Error("net"));
    expect(() => postCuePresence(P, { clientId: "k", userName: "n", listId: L, cueId: null })).not.toThrow();
    await Promise.resolve();
    expect(lastCall()[1]).toMatchObject({ method: "POST", body: JSON.stringify({ clientId: "k", userName: "n", listId: L, cueId: null }) });
    const resp = { ok: true, body: {} };
    fetchMock.mockResolvedValueOnce(resp);
    expect(await startCueExport(P, { cueListIds: [L], wikiUrl: "" })).toBe(resp);
    expect(lastCall()[0]).toBe(`${BASE_PATH}/api/production/${P}/export-cues`);
  });
});
