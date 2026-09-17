import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BASE_PATH } from "@/lib/base-path";
import {
  fetchScriptState, loadScriptEnvelope, patchScript, putScriptConfig,
  fetchTagGroups, fetchBlockTags, fetchSceneDetails,
  createScene, renameScene, deleteScene, patchSceneMetadata,
  fetchScriptComments, postScriptComment, patchScriptComment, deleteScriptComment,
  fetchBlockAssetSummary, postScriptPresence,
} from "@/lib/script/script-client";

/**
 * 剧本编辑器浏览器端 client（#487 S8 从 ScriptEditor 及其族目录收拢）。钉两件事：每个函数打的
 * URL / method / body 与搬出前逐字一致；返回形状就是原来各处 res.ok / status 分支的语义。
 */
const S = "scr_1"; const P = "p_x"; const V = "v9";
const fetchMock = vi.fn();
function respond(status: number, json?: unknown, jsonThrows = false) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300, status,
    json: async () => { if (jsonThrows) throw new Error("bad json"); return json; },
  });
}
const lastCall = () => fetchMock.mock.calls.at(-1) as [string, RequestInit | undefined];
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("剧本状态", () => {
  it("fetchScriptState：带版本参数；非 ok 为 null", async () => {
    respond(200, { blocks: [] });
    expect(await fetchScriptState(S, V)).toEqual({ blocks: [] });
    expect(lastCall()[0]).toBe(`${BASE_PATH}/api/script/${S}?v=${V}`);
    respond(500);
    expect(await fetchScriptState(S, null)).toBe(null);
    expect(lastCall()[0]).toBe(`${BASE_PATH}/api/script/${S}`);
  });

  it("loadScriptEnvelope：有项目走项目路由、没有走剧本路由；status 与 body 原样交回", async () => {
    respond(200, { state: { blocks: [] }, versionId: V });
    expect(await loadScriptEnvelope(P, S, V)).toEqual({ status: 200, ok: true, body: { state: { blocks: [] }, versionId: V } });
    expect(lastCall()[0]).toBe(`${BASE_PATH}/api/production/${P}?v=${V}`);
    respond(404, { error: "no" });
    expect(await loadScriptEnvelope(undefined, S, undefined)).toEqual({ status: 404, ok: false, body: { error: "no" } });
    expect(lastCall()[0]).toBe(`${BASE_PATH}/api/script/${S}`);
  });

  it("patchScript 回序号或 null；putScriptConfig 回 ok", async () => {
    respond(200, { ok: true, serverSeq: 7 });
    expect(await patchScript(S, V, { blockOps: [] })).toEqual({ ok: true, serverSeq: 7 });
    expect(lastCall()).toEqual([`${BASE_PATH}/api/script/${S}?v=${V}`, expect.objectContaining({ method: "PATCH", body: JSON.stringify({ blockOps: [] }) })]);
    respond(409);
    expect(await patchScript(S, V, {})).toBe(null);
    respond(200);
    expect(await putScriptConfig(S, null, { useRehearsalMarks: true } as never)).toBe(true);
    expect(lastCall()).toEqual([`${BASE_PATH}/api/script/${S}/config`, expect.objectContaining({ method: "PUT", body: JSON.stringify({ useRehearsalMarks: true }) })]);
  });
});

describe("标签 / 场次", () => {
  it("tag-groups / block-tags 信封原样；非 ok 为 null", async () => {
    respond(200, { groups: [{ id: "g" }] });
    expect(await fetchTagGroups(P)).toEqual({ groups: [{ id: "g" }] });
    expect(lastCall()[0]).toBe(`${BASE_PATH}/api/production/${P}/tag-groups`);
    respond(403);
    expect(await fetchBlockTags(S)).toBe(null);
    expect(lastCall()[0]).toBe(`${BASE_PATH}/api/script/${S}/block-tags`);
  });

  it("fetchSceneDetails：非数组 / 非 ok / 网络错都为 null", async () => {
    respond(200, [{ id: "s1" }]);
    expect(await fetchSceneDetails(P, V)).toEqual([{ id: "s1" }]);
    expect(lastCall()[0]).toBe(`${BASE_PATH}/api/production/${P}/scenes?versionId=${V}`);
    respond(200, { nope: 1 });
    expect(await fetchSceneDetails(P, V)).toBe(null);
    fetchMock.mockRejectedValueOnce(new Error("net"));
    expect(await fetchSceneDetails(P, V)).toBe(null);
  });

  it("createScene / renameScene 交回 Response；deleteScene 带 status 与解析失败兜底的 data；patchSceneMetadata 回 ok", async () => {
    const resp = { ok: true, status: 201 };
    fetchMock.mockResolvedValueOnce(resp);
    expect(await createScene(P, { name: "一" })).toBe(resp);
    expect(lastCall()).toEqual([`${BASE_PATH}/api/production/${P}/scenes`, expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "一" }) })]);
    fetchMock.mockResolvedValueOnce(resp);
    await renameScene(P, "s1", { name: "二", versionId: V });
    expect(lastCall()).toEqual([`${BASE_PATH}/api/production/${P}/scenes/s1`, expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "二", versionId: V }) })]);
    respond(300, { plan: { status: "choice" } });
    expect(await deleteScene(P, "s1", { versionId: V })).toEqual({ status: 300, ok: false, data: { plan: { status: "choice" } } });
    expect(lastCall()).toEqual([`${BASE_PATH}/api/production/${P}/scenes/s1`, expect.objectContaining({ method: "DELETE", body: JSON.stringify({ versionId: V }) })]);
    respond(500, undefined, true);
    expect(await deleteScene(P, "s1", {})).toEqual({ status: 500, ok: false, data: {} });
    respond(200);
    expect(await patchSceneMetadata(P, "s1", { synopsis: "x" })).toBe(true);
  });
});

describe("评论 / 资产气泡 / 在场", () => {
  it("评论四件：信封字段 comments / comment；失败 null / false", async () => {
    respond(200, { comments: [{ id: "c1" }] });
    expect(await fetchScriptComments(P)).toEqual([{ id: "c1" }]);
    expect(lastCall()[0]).toBe(`${BASE_PATH}/api/script/${P}/comments`);
    respond(200, { comment: { id: "c2" } });
    expect(await postScriptComment(P, { blockId: "b", body: "hi", parentId: null, mentions: [] })).toEqual({ id: "c2" });
    expect(lastCall()[1]).toMatchObject({ method: "POST", body: JSON.stringify({ blockId: "b", body: "hi", parentId: null, mentions: [] }) });
    respond(200, { comment: { id: "c2", body: "e" } });
    expect(await patchScriptComment(P, "c2", "e")).toEqual({ id: "c2", body: "e" });
    expect(lastCall()[0]).toBe(`${BASE_PATH}/api/script/${P}/comments/c2`);
    respond(404);
    expect(await deleteScriptComment(P, "c2")).toBe(false);
  });

  it("block-summary：不带 ?v=；非 ok / 网络错为 null", async () => {
    respond(200, { blocks: [{ blockId: "b", asset: { id: "a" } }] });
    expect(await fetchBlockAssetSummary(P)).toEqual([{ blockId: "b", asset: { id: "a" } }]);
    expect(lastCall()[0]).toBe(`${BASE_PATH}/api/production/${P}/assets/block-summary`);
    fetchMock.mockRejectedValueOnce(new Error("net"));
    expect(await fetchBlockAssetSummary(P)).toBe(null);
  });

  it("在场上报 fire-and-forget，带版本参数，网络错不抛", async () => {
    fetchMock.mockRejectedValueOnce(new Error("net"));
    expect(() => postScriptPresence(S, V, { clientId: "k", userName: "n", blockId: "b" })).not.toThrow();
    await Promise.resolve();
    expect(lastCall()).toEqual([`${BASE_PATH}/api/script/${S}/presence?v=${V}`, expect.objectContaining({ method: "POST", body: JSON.stringify({ clientId: "k", userName: "n", blockId: "b" }) })]);
  });
});
