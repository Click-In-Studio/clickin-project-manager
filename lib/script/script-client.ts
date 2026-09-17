// 剧本编辑器的浏览器端 API 调用（#487 S8）。ScriptEditor 及其族目录里打剧本域端点的 fetch 都收在
// 这里：组件只拿整形好的结果，不碰 URL / method / 响应体。每个函数的成功 / 失败语义与搬出前
// 逐条一致——需要按状态码分支的（加载、删场次）把 status 一起交回，其余按 ok 折成 null / boolean。
//
// 跨域端点（/api/me、mention-users、assets/*/mounts）不在这里，等各自域的 client。
import { BASE_PATH } from "@/lib/base-path";
import type { ScriptConfig, ScriptState } from "@/lib/script/script-types";
import type { SceneDetail, TagGroup, BlockTagValue } from "@/lib/db";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/** 版本参数：读写都带当前剧本版本，服务端按它分辨是哪份修订。 */
function versionQuery(versionId: string | null | undefined): string {
  return versionId ? `?v=${encodeURIComponent(versionId)}` : "";
}

// ── 剧本状态 ─────────────────────────────────────────────────────────────────

/** 整份剧本状态；非 ok 为 null。 */
export async function fetchScriptState(scriptId: string, versionId: string | null | undefined): Promise<ScriptState | null> {
  const r = await fetch(`${BASE_PATH}/api/script/${scriptId}${versionQuery(versionId)}`);
  return r.ok ? (await r.json() as ScriptState) : null;
}

/**
 * 首次加载：有项目走项目路由（回 { state, versionId, … }），没有走裸剧本路由（直接回 ScriptState）。
 * 调用方按 status 与响应体形状分支，所以这里原样交回。
 */
export async function loadScriptEnvelope(
  productionId: string | undefined, scriptId: string, versionId: string | null | undefined,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const v = versionQuery(versionId);
  const url = productionId ? `${BASE_PATH}/api/production/${productionId}${v}` : `${BASE_PATH}/api/script/${scriptId}${v}`;
  const r = await fetch(url);
  return { status: r.status, ok: r.ok, body: await r.json() };
}

/** 增量 PATCH；ok 时回服务端序号，否则 null。 */
export async function patchScript(
  scriptId: string, versionId: string | null | undefined, patch: unknown,
): Promise<{ ok: boolean; serverSeq: number } | null> {
  const res = await fetch(`${BASE_PATH}/api/script/${scriptId}${versionQuery(versionId)}`, {
    method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(patch),
  });
  return res.ok ? (await res.json() as { ok: boolean; serverSeq: number }) : null;
}

export async function putScriptConfig(scriptId: string, versionId: string | null | undefined, config: ScriptConfig): Promise<boolean> {
  const response = await fetch(`${BASE_PATH}/api/script/${scriptId}/config${versionQuery(versionId)}`, {
    method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(config),
  });
  return response.ok;
}

// ── 标签 ─────────────────────────────────────────────────────────────────────

export async function fetchTagGroups(productionId: string): Promise<{ groups?: TagGroup[] } | null> {
  return fetch(`${BASE_PATH}/api/production/${productionId}/tag-groups`).then(r => r.ok ? r.json() : null);
}

export async function fetchBlockTags(scriptId: string): Promise<{ tags?: BlockTagValue[] } | null> {
  return fetch(`${BASE_PATH}/api/script/${scriptId}/block-tags`).then(r => r.ok ? r.json() : null);
}

// ── 场次 ─────────────────────────────────────────────────────────────────────

/** 场次详情列表；非 ok 或形状不对为 null（调用方原本按 Array.isArray 判）。 */
export async function fetchSceneDetails(productionId: string, versionId: string): Promise<SceneDetail[] | null> {
  return fetch(`${BASE_PATH}/api/production/${productionId}/scenes?versionId=${encodeURIComponent(versionId)}`)
    .then((r) => r.ok ? r.json() : null)
    .then((data) => Array.isArray(data) ? data as SceneDetail[] : null)
    .catch(() => null);
}

/** 新建 / 改名走「场次菜单」统一的失败提示流，只要 ok 位；交回 Response 让那条流自己判。 */
export function createScene(productionId: string, payload: unknown): Promise<Response> {
  return fetch(`${BASE_PATH}/api/production/${productionId}/scenes`, {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify(payload),
  });
}

export function renameScene(productionId: string, sceneId: string, body: unknown): Promise<Response> {
  return fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${sceneId}`, {
    method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body),
  });
}

/**
 * 删场次：服务端可能回 300（要用户选删法）或 409（被阻）并附 plan，调用方按 status 分支，
 * 所以 status 与响应体一起交回；响应体解析失败按 {}。
 */
export async function deleteScene(
  productionId: string, sceneId: string, body: unknown,
): Promise<{ status: number; ok: boolean; data: { plan?: unknown; error?: string } }> {
  const response = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${sceneId}`, {
    method: "DELETE", headers: JSON_HEADERS, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, data };
}

export async function patchSceneMetadata(productionId: string, sceneId: string, body: unknown): Promise<boolean> {
  const response = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${sceneId}`, {
    method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body),
  });
  return response.ok;
}

// ── 评论 / 资产气泡 ──────────────────────────────────────────────────────────

/** 评论的形状由编辑器自己的 types 定义；client 只保证信封字段名。 */
export async function fetchScriptComments<C>(productionId: string): Promise<C[] | null> {
  return fetch(`${BASE_PATH}/api/script/${productionId}/comments`)
    .then(r => r.ok ? r.json() : null)
    .then((d: { comments?: C[] } | null) => d?.comments ?? null)
    .catch(() => null);
}

export async function postScriptComment<C>(
  productionId: string,
  body: { blockId: string; body: string; parentId: string | null; mentions: unknown },
): Promise<C | null> {
  const res = await fetch(`${BASE_PATH}/api/script/${productionId}/comments`, {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body),
  });
  return res.ok ? ((await res.json()).comment as C) : null;
}

export async function patchScriptComment<C>(productionId: string, commentId: string, text: string): Promise<C | null> {
  const res = await fetch(`${BASE_PATH}/api/script/${productionId}/comments/${commentId}`, {
    method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ body: text }),
  });
  return res.ok ? ((await res.json()).comment as C) : null;
}

export async function deleteScriptComment(productionId: string, commentId: string): Promise<boolean> {
  const res = await fetch(`${BASE_PATH}/api/script/${productionId}/comments/${commentId}`, { method: "DELETE" });
  return res.ok;
}

/** 块 → 资产气泡的汇总；非 ok 为 null，网络错也为 null（调用方原本 catch 后清空）。 */
export async function fetchBlockAssetSummary<A>(productionId: string): Promise<Array<{ blockId: string; asset: A }> | null> {
  // #420：挂载锚稳定 block_id，服务端无版本分辨路径，不传 ?v=
  return fetch(`${BASE_PATH}/api/production/${productionId}/assets/block-summary`)
    .then(r => r.ok ? r.json() : null)
    .then((data: { blocks?: Array<{ blockId: string; asset: A }> } | null) => data?.blocks ?? null)
    .catch(() => null);
}

// ── 在场 ─────────────────────────────────────────────────────────────────────

/** fire-and-forget：失败静默，节流由调用方做。 */
export function postScriptPresence(
  scriptId: string, versionId: string | null | undefined,
  body: { clientId: string; userName: string; blockId: string | null },
): void {
  fetch(`${BASE_PATH}/api/script/${scriptId}/presence${versionQuery(versionId)}`, {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body),
  }).catch(() => {});
}
