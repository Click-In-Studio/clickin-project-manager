// cue 页的浏览器端 API 调用（#487 C4）。CuePage 及其族目录里所有打 cue 域端点的 fetch 都收在
// 这里：组件只拿整形好的结果，不碰 URL / method / 响应体。每个函数的成功 / 失败语义与搬出
// 前逐条一致——`null` / `false` / `[]` 各表示原来那处 `res.ok` 为假的分支。
//
// 跨域端点（/api/me、mention-users、contacts、assets/*/mounts）不在这里：它们属于各自的域，
// 等那些域有自己的 client 再搬。
import { BASE_PATH } from "@/lib/base-path";
import type { Cue, CueAnchor } from "@/lib/ops/cue-types";
import type { CueListGrant, CueListDeptAccess } from "@/lib/ops/cue-list-types";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function cuesUrl(productionId: string, listId: string, versionId: string | null | undefined): string {
  const vParam = versionId ? `?v=${encodeURIComponent(versionId)}` : "";
  return `${BASE_PATH}/api/production/${productionId}/cuelists/${listId}/cues${vParam}`;
}
function cueUrl(productionId: string, listId: string, cueId: string, versionId: string | null | undefined): string {
  const vParam = versionId ? `?v=${encodeURIComponent(versionId)}` : "";
  return `${BASE_PATH}/api/production/${productionId}/cuelists/${listId}/cues/${cueId}${vParam}`;
}

// ── cue CRUD ─────────────────────────────────────────────────────────────────

export type CueFieldPatch = {
  number?: string; name?: string; content?: string; warning?: boolean; start?: CueAnchor; end?: CueAnchor;
};

/** PATCH 单条 cue。409 是权限 / 冲突拒绝，带服务端的 error 文案回去给调用方提示。 */
export async function patchCue(
  productionId: string, listId: string, cueId: string, versionId: string | null | undefined, fields: CueFieldPatch,
): Promise<{ ok: true } | { ok: false; status: number; error?: string }> {
  const res = await fetch(cueUrl(productionId, listId, cueId, versionId), {
    method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(fields),
  });
  if (res.ok) return { ok: true };
  if (res.status === 409) {
    const body = await res.json() as { error: string };
    return { ok: false, status: 409, error: body.error };
  }
  return { ok: false, status: res.status };
}

/** 一张表的全部 cue；失败按空表处理（重拉是对账，不阻塞）。 */
export async function fetchListCues(productionId: string, listId: string, versionId: string | null | undefined): Promise<Cue[]> {
  return fetch(cuesUrl(productionId, listId, versionId))
    .then(r => r.ok ? (r.json() as Promise<Cue[]>) : [])
    .catch(() => [] as Cue[]);
}

/** 新建一条 cue；服务端回整张表的 cue 列表（编号可能重排）。失败为 null。 */
export async function createCue(
  productionId: string, listId: string, versionId: string | null | undefined,
  body: { number: string; name: string; content: string; start: CueAnchor; end: CueAnchor },
): Promise<Cue[] | null> {
  const res = await fetch(cuesUrl(productionId, listId, versionId), {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body),
  });
  return res.ok ? (await res.json() as Cue[]) : null;
}

export async function deleteCueRemote(productionId: string, listId: string, cueId: string, versionId: string | null | undefined): Promise<boolean> {
  const res = await fetch(cueUrl(productionId, listId, cueId, versionId), { method: "DELETE" });
  return res.ok;
}

// ── cue 表访问（Phase 4 自确认）─────────────────────────────────────────────

export type CueListAccess =
  | { canAccess: true; level?: string }
  | { canAccess: false; canSelfConfirm: true; selfConfirmLevel: "edit" | "manage" }
  | { canAccess: false; canSelfConfirm: false };

/** 问服务端当前用户对这张表的访问状态；请求失败为 null（调用方关弹窗）。 */
export async function fetchCueListAccess(productionId: string, listId: string): Promise<CueListAccess | null> {
  const res = await fetch(`${BASE_PATH}/api/production/${productionId}/cuelists/${listId}/access`, { credentials: "include" });
  return res.ok ? (await res.json() as CueListAccess) : null;
}

export async function selfConfirmCueListAccess(productionId: string, listId: string, level: "edit" | "manage"): Promise<boolean> {
  const res = await fetch(`${BASE_PATH}/api/production/${productionId}/cuelists/${listId}/access`, {
    method: "POST", headers: JSON_HEADERS, credentials: "include",
    body: JSON.stringify({ action: "self_confirm", level }),
  });
  return res.ok;
}

// ── 协作者（分享弹窗）───────────────────────────────────────────────────────

export type CueListCollaborators = { grants: CueListGrant[]; deptAccess: CueListDeptAccess[] };
export type CueListCollaboratorsWithDepts = CueListCollaborators & { productionDepts: { id: string; name: string }[] };

function collaboratorsUrl(productionId: string, listId: string): string {
  return `${BASE_PATH}/api/production/${productionId}/cuelists/${listId}/collaborators`;
}

export async function fetchCueListCollaborators(productionId: string, listId: string): Promise<CueListCollaboratorsWithDepts | null> {
  const res = await fetch(collaboratorsUrl(productionId, listId), { credentials: "include" });
  return res.ok ? (await res.json() as CueListCollaboratorsWithDepts) : null;
}

export async function addCueListCollaborator(productionId: string, listId: string, body: object): Promise<CueListCollaborators | null> {
  const res = await fetch(collaboratorsUrl(productionId, listId), {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body), credentials: "include",
  });
  return res.ok ? (await res.json() as CueListCollaborators) : null;
}

export async function removeCueListCollaborator(productionId: string, listId: string, body: object): Promise<CueListCollaborators | null> {
  const res = await fetch(collaboratorsUrl(productionId, listId), {
    method: "DELETE", headers: JSON_HEADERS, body: JSON.stringify(body), credentials: "include",
  });
  return res.ok ? (await res.json() as CueListCollaborators) : null;
}

// ── 评论 ─────────────────────────────────────────────────────────────────────

/** 评论的形状由页面自己的 types 定义；client 只保证信封字段名，泛型交给调用方。 */
export async function fetchCueComments<C>(productionId: string): Promise<C[] | null> {
  return fetch(`${BASE_PATH}/api/production/${productionId}/cue-comments`)
    .then(r => r.ok ? r.json() : null)
    .then((d: { comments?: C[] } | null) => d?.comments ?? null)
    .catch(() => null);
}

export async function postCueComment<C>(
  productionId: string,
  body: { cueId: string; body: string; parentId: string | null; mentions: unknown },
): Promise<C | null> {
  const res = await fetch(`${BASE_PATH}/api/production/${productionId}/cue-comments`, {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body),
  });
  return res.ok ? ((await res.json()).comment as C) : null;
}

export async function patchCueComment<C>(productionId: string, commentId: string, text: string): Promise<C | null> {
  const res = await fetch(`${BASE_PATH}/api/production/${productionId}/cue-comments/${commentId}`, {
    method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ body: text }),
  });
  return res.ok ? ((await res.json()).comment as C) : null;
}

export async function deleteCueComment(productionId: string, commentId: string): Promise<boolean> {
  const res = await fetch(`${BASE_PATH}/api/production/${productionId}/cue-comments/${commentId}`, { method: "DELETE" });
  return res.ok;
}

// ── 在场 ─────────────────────────────────────────────────────────────────────

/** fire-and-forget：失败静默，节流由调用方做。 */
export function postCuePresence(
  productionId: string,
  body: { clientId: string; userName: string; listId: string | null; cueId: string | null },
): void {
  fetch(`${BASE_PATH}/api/production/${productionId}/cue-presence`, {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body),
  }).catch(() => {});
}

// ── 导出 ─────────────────────────────────────────────────────────────────────

/** 导出是流式响应（逐行进度），调用方自己读 body；这里只负责发起。 */
export function startCueExport(productionId: string, body: { cueListIds: string[]; wikiUrl: string }): Promise<Response> {
  return fetch(`${BASE_PATH}/api/production/${productionId}/export-cues`, {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body),
  });
}
