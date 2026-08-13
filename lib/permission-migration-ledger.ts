/**
 * 权限REST化 Migration 棘轮账本（批0 基建）。
 *
 * 权威映射表在 MindWeave《Click-In/后台/权限系统/权限REST化-Migration总表》。
 * 本文件是它在 CI 里的机器可判形态：
 *
 *   - 账本里的键 = 待迁移（含目标批次）
 *   - 一批完成 = 该批键从 Permission type 删除 + 从本账本删行 + 加入 RETIRED_PERMISSION_KEYS
 *   - tests/permission-migration-ledger.test.ts 强制三条不变量：
 *       1. 账本键集合 === ALL_PERMISSIONS 集合（谁忘了删/漏了记 → 红）
 *       2. RETIRED 键在 app/ lib/ components/ 源码中 grep 不到（遗留消费点 → 红）
 *       3. RETIRED 与账本无交集
 *
 *   迁移全部完成的终局：本账本为空、Permission type 删除、atomic_permission_grant DROP。
 */

export type LedgerBatch = "A" | "B" | "C" | "D" | "E" | "F" | "G";

/** 待迁移原子键 → 目标批次。做完一批删一批。 */
export const PERMISSION_MIGRATION_LEDGER: Record<string, LedgerBatch> = {
  // production → 批F
  // contacts → 批F
  // members → 批F
  // role → 批F
  // dept → 批F
  // script → 批E
  // dramaturgy → 批E
  // asset → 批D
  // dramaturgy_view → 批E
  // character → 批E
  // tag_group → 批E
  // tag_option → 批E
  // script → 批E
  // milestone → 批F
  // announcement → 批F
  // production → 批F
  // script → 批E
  // rehearsal_mark → 批E
  // script → 批E
  // scene → 批E
  // dramaturgy_view → 批E
  // character → 批E
  // production → 批F
  // asset → 批D
  // scene → 批E
  // character → 批E
  // script → 批E
  // contacts → 批F
  // asset → 批D
  // script → 批E
  // org → 批G
};

/** 已退役键：源码中不得再出现（棘轮测试逐文件扫描字符串）。每批完成时追加。 */
export const RETIRED_PERMISSION_KEYS: readonly string[] = [
  // 批G G-2（org 功能已移除，直接移除不转换；终局：原子键全集清零）
  "org:assign_member",
  "org:recall_member",

  // 批F（治理域，2026-08-13）
  "announcement:create",
  "announcement:delete",
  "announcement:edit",
  "contacts:import",
  "contacts:view",
  "dept:add_member",
  "dept:change_type",
  "dept:create",
  "dept:delete_member",
  "dept:dismiss",
  "dept:rename",
  "dept:set_poc",
  "dept:unset_poc",
  "members:change_role",
  "members:invite",
  "members:kick",
  "members:manage_overrides",
  "milestone:create",
  "milestone:delete",
  "milestone:manage",
  "production:archive",
  "production:change_avatar",
  "production:change_language",
  "production:change_type",
  "production:delete",
  "production:edit_description",
  "production:import_members",
  "production:manage_config",
  "production:manage_integrations",
  "production:mount",
  "production:producer_demote",
  "production:producer_invite",
  "production:producer_kick",
  "production:producer_promote",
  "production:rename",
  "production:restore_checkpoint",
  "production:transfer_owner",
  "production:unmount",
  "role:assign_permission",
  "role:create",
  "role:delete",
  "role:rename",

  // 批E PR-E3（dramaturgy_view 个人视图，2026-08-13）
  "dramaturgy_view:create",
  "dramaturgy_view:create_public",
  "dramaturgy_view:delete",
  "dramaturgy_view:delete_public",
  "dramaturgy_view:overwrite",
  "dramaturgy_view:overwrite_public",

  // 批E PR-E2（script/rehearsal_mark/dramaturgy:import，2026-08-12）
  "dramaturgy:import",
  "rehearsal_mark:create",
  "rehearsal_mark:delete",
  "rehearsal_mark:edit",
  "rehearsal_mark:move",
  "script:annotate",
  "script:comment",
  "script:create_block",
  "script:delete_block",
  "script:delete_comment_any",
  "script:edit",
  "script:edit_block",
  "script:edit_comment_any",
  "script:import",
  "script:manage",
  "script:mount",
  "script:reorder",
  "script:set_character",
  "script:set_tag",
  "script:set_type",
  "script:view",

  // 批E PR-E1（scene/character/tag 域，2026-08-12）
  "character:change_type",
  "character:create",
  "character:delete",
  "character:edit_biography",
  "character:edit_gender",
  "character:edit_role_type",
  "character:rename",
  "character:set_members",
  "character:view",
  "scene:change_type",
  "scene:create",
  "scene:delete",
  "scene:edit_action_line",
  "scene:edit_expected_duration",
  "scene:edit_music",
  "scene:edit_stage_notes",
  "scene:edit_synopsis",
  "scene:mount",
  "scene:rename",
  "scene:renumber",
  "scene:view",
  "tag_group:create",
  "tag_group:delete",
  "tag_group:edit_range_config",
  "tag_group:rename",
  "tag_group:reorder",
  "tag_group:set_default_option",
  "tag_group:set_lyric_split",
  "tag_option:create",
  "tag_option:delete",
  "tag_option:edit_color",
  "tag_option:rename",
  "tag_option:reorder",

  // 批D（asset 域 REST 化，2026-08-12）
  "asset:view_any",
  "asset:delete_any",
  "asset:rename_any",
  "asset:change_type_any",
  "asset:overwrite_any",
  "asset:mount_any",
  "asset:unmount_any",
  "asset:create",
  "asset:rename",
  "asset:overwrite",
  "asset:change_type",
  "asset:delete",
  "asset:mount",
  "asset:unmount",
  "asset:view",
  "asset:download",
  "asset:download_any",
  "asset:share",
  "asset:share_downloadable",
  "asset:share_any",
  "asset:share_any_downloadable",
  // 批A（cue 域，2026-08-11）
  // 批B（event/task 域，2026-08-12）
  // 批C（report/note 域，2026-08-12）
  "report:create",
  "report:delete_comment_any",
  "report:edit_comment_any",
  "report:reply",
  "event:create",
  "event:follow",
  "event:view_call_sheet_any",
  "task:delete_any",
  "task:view",
  "task:view_any",
  "cue:comment",
  "cue:create",
  "cue:create_any",
  "cue:delete",
  "cue:delete_any",
  "cue:delete_comment_any",
  "cue:edit_comment_any",
  "cue:edit_description",
  "cue:edit_description_any",
  "cue:mount",
  "cue:mount_any",
  "cue:move",
  "cue:move_any",
  "cue:rename",
  "cue:rename_any",
  "cue:renumber",
  "cue:renumber_any",
  "cue:view",
  "cue_list:create",
  "cue_list:create_any",
  "cue_list:delete",
  "cue_list:delete_any",
  "cue_list:edit_abbr",
  "cue_list:edit_abbr_any",
  "cue_list:edit_description",
  "cue_list:edit_description_any",
  "cue_list:manage_permissions",
  "cue_list:manage_permissions_any",
  "cue_list:rename",
  "cue_list:rename_any",
  "cue_list:reorder",
  "cue_list:reorder_any",
  "cue_list:view",
];

/**
 * resource_permission_level 旧级别的退役账本（view/edit 字符串沿用为动词，不在此列）。
 * 完成一批：对应级别的 grant 行迁移为动词行 + 从词汇表删行 + 从此处删行。
 */
export const RESOURCE_LEVEL_MIGRATION_LEDGER: Record<string, LedgerBatch> = {
  "asset:manage": "D",
  "scene:manage": "E",
  "script_view:manage": "E",
};
