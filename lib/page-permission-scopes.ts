import type { Permission } from "./permissions";

/**
 * Per-page atomic permission scopes for the self-confirm gate.
 * On entry to each page / context, we check if the user has any selfConfirmable
 * permissions in the relevant scope and prompt a one-click activation.
 *
 * `base` handles the Level 1 view-grant notification (see AppShell):
 * after #158 removed the MEMBER_BASE_PERMISSIONS bypass, view-class perms
 * go through the same role→selfConfirm→grant path as all other permissions.
 */
export const PAGE_PERMISSION_SCOPES = {
  base: new Set<string>([
    // 批A：cue 域读权限改为树节点键（node:<type>/<id>[/<sub>]@<verb>）
    "node:cue_list/*/meta@view",
    "node:cue_list/*/cues@view",
    "node:cue_list/*/cues/comments@create",
    // 批B：event 域读取+订阅（原 event:follow 两职拆分）
    "node:event/*/meta@view",
    "node:event/*/details@view",
    "node:event/*/followers@create",
    "contacts:view",
  ]),
  script: new Set<Permission>([
  ]),

  dramaturgy: new Set<Permission>([
  ]),

  characters: new Set<Permission>([
  ]),

  // 批A：cue 域激活面全部走树节点键。集合 create 是唯一需要页面级激活的
  // 生产级能力；每表写权限由 CuePage 的 per-list access 流处理（zone self-confirm）。
  cuelists: new Set<string>([
    "node:cue_list/*@create",
  ]),

  events: new Set<string>([
    // 批B：事件管理激活面（原 event:create/view_call_sheet_any/task:* 原子键）
    "node:event/*@create",
    "node:event/*/chat@create",
    "node:event/*/call_sheet@view",
    "node:task/*@view",
    "node:task/*@delete",
  ]),

  reports: new Set<string>([
    // 批C：报告挂接与评论管理走树节点键
    "node:event/*/reports@create",
    "node:report/*/replies@create",
    "node:report/*/replies@edit",
    "node:report/*/replies@delete",
  ]),

  assets: new Set<Permission>([
  ]),
} as const;

export type PageScope = keyof typeof PAGE_PERMISSION_SCOPES;
