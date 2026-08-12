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
    "scene:view",
    "character:view",
    "script:view",
    // 批A：cue 域读权限改为树节点键（node:<type>/<id>[/<sub>]@<verb>）
    "node:cue_list/*/meta@view",
    "node:cue_list/*/cues@view",
    "node:cue_list/*/cues/comments@create",
    // 批B：event 域读取+订阅（原 event:follow 两职拆分）
    "node:event/*/meta@view",
    "node:event/*/details@view",
    "node:event/*/followers@create",
    "contacts:view",
    "asset:view",
    "asset:download",
    "asset:share",
  ]),
  script: new Set<Permission>([
    "script:import",
    "script:manage",
    "script:edit",
    "script:annotate",
    "script:comment",
    "script:create_block",
    "script:delete_block",
    "script:edit_block",
    "script:set_character",
    "script:set_type",
    "script:set_tag",
    "script:reorder",
    "script:mount",
    "script:edit_comment_any",
    "script:delete_comment_any",
    "rehearsal_mark:create",
    "rehearsal_mark:edit",
    "rehearsal_mark:delete",
    "rehearsal_mark:move",
  ]),

  dramaturgy: new Set<Permission>([
    "scene:create",
    "scene:delete",
    "scene:rename",
    "scene:renumber",
    "scene:change_type",
    "scene:edit_synopsis",
    "scene:edit_action_line",
    "scene:edit_music",
    "scene:edit_stage_notes",
    "scene:edit_expected_duration",
    "scene:mount",
    "dramaturgy:import",
    "dramaturgy_view:create",
    "dramaturgy_view:delete",
    "dramaturgy_view:overwrite",
    "dramaturgy_view:create_public",
    "dramaturgy_view:delete_public",
    "dramaturgy_view:overwrite_public",
    "tag_group:create",
    "tag_group:delete",
    "tag_group:rename",
    "tag_group:edit_range_config",
    "tag_group:set_default_option",
    "tag_group:set_lyric_split",
    "tag_group:reorder",
    "tag_option:create",
    "tag_option:delete",
    "tag_option:rename",
    "tag_option:edit_color",
    "tag_option:reorder",
  ]),

  characters: new Set<Permission>([
    "character:create",
    "character:delete",
    "character:rename",
    "character:change_type",
    "character:set_members",
    "character:edit_gender",
    "character:edit_biography",
    "character:edit_role_type",
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
    "asset:rename",
    "asset:overwrite",
    "asset:change_type",
    "asset:delete",
    "asset:mount",
    "asset:unmount",
    "asset:view_any",
    "asset:delete_any",
    "asset:rename_any",
    "asset:change_type_any",
    "asset:overwrite_any",
    "asset:mount_any",
    "asset:unmount_any",
    "asset:download_any",
    "asset:share_downloadable",
    "asset:share_any",
    "asset:share_any_downloadable",
  ]),
} as const;

export type PageScope = keyof typeof PAGE_PERMISSION_SCOPES;
