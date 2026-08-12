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
  "production:delete": "F",
  "production:transfer_owner": "F",
  "production:restore_checkpoint": "F",
  "production:archive": "F",
  "production:rename": "F",
  "production:change_avatar": "F",
  "production:edit_description": "F",
  "production:change_type": "F",
  "production:change_language": "F",
  "production:manage_integrations": "F",
  "production:import_members": "F",
  "production:producer_invite": "F",
  "production:producer_promote": "F",
  "production:producer_demote": "F",
  "production:producer_kick": "F",
  // contacts → 批F
  "contacts:import": "F",
  // members → 批F
  "members:invite": "F",
  "members:kick": "F",
  "members:change_role": "F",
  "members:manage_overrides": "F",
  // role → 批F
  "role:create": "F",
  "role:rename": "F",
  "role:delete": "F",
  "role:assign_permission": "F",
  // dept → 批F
  "dept:create": "F",
  "dept:dismiss": "F",
  "dept:rename": "F",
  "dept:change_type": "F",
  "dept:add_member": "F",
  "dept:delete_member": "F",
  "dept:set_poc": "F",
  "dept:unset_poc": "F",
  // script → 批E
  "script:import": "E",
  // dramaturgy → 批E
  "dramaturgy:import": "E",
  // asset → 批D
  "asset:view_any": "D",
  "asset:delete_any": "D",
  "asset:rename_any": "D",
  "asset:change_type_any": "D",
  "asset:overwrite_any": "D",
  "asset:mount_any": "D",
  "asset:unmount_any": "D",
  // dramaturgy_view → 批E
  "dramaturgy_view:create_public": "E",
  "dramaturgy_view:delete_public": "E",
  "dramaturgy_view:overwrite_public": "E",
  // character → 批E
  "character:delete": "E",
  // tag_group → 批E
  "tag_group:create": "E",
  "tag_group:delete": "E",
  "tag_group:rename": "E",
  "tag_group:edit_range_config": "E",
  "tag_group:set_default_option": "E",
  "tag_group:set_lyric_split": "E",
  "tag_group:reorder": "E",
  // tag_option → 批E
  "tag_option:create": "E",
  "tag_option:delete": "E",
  "tag_option:rename": "E",
  "tag_option:edit_color": "E",
  "tag_option:reorder": "E",
  // script → 批E
  "script:edit_comment_any": "E",
  "script:delete_comment_any": "E",
  // milestone → 批F
  "milestone:create": "F",
  "milestone:manage": "F",
  "milestone:delete": "F",
  // announcement → 批F
  "announcement:create": "F",
  "announcement:edit": "F",
  "announcement:delete": "F",
  // production → 批F
  "production:manage_config": "F",
  // script → 批E
  "script:manage": "E",
  "script:edit": "E",
  "script:annotate": "E",
  // rehearsal_mark → 批E
  "rehearsal_mark:create": "E",
  "rehearsal_mark:edit": "E",
  "rehearsal_mark:delete": "E",
  "rehearsal_mark:move": "E",
  // script → 批E
  "script:create_block": "E",
  "script:delete_block": "E",
  "script:edit_block": "E",
  "script:set_character": "E",
  "script:set_type": "E",
  "script:set_tag": "E",
  "script:reorder": "E",
  "script:mount": "E",
  // scene → 批E
  "scene:create": "E",
  "scene:delete": "E",
  "scene:rename": "E",
  "scene:renumber": "E",
  "scene:change_type": "E",
  "scene:edit_synopsis": "E",
  "scene:edit_action_line": "E",
  "scene:edit_music": "E",
  "scene:edit_stage_notes": "E",
  "scene:edit_expected_duration": "E",
  "scene:mount": "E",
  // dramaturgy_view → 批E
  "dramaturgy_view:create": "E",
  "dramaturgy_view:delete": "E",
  "dramaturgy_view:overwrite": "E",
  // character → 批E
  "character:create": "E",
  "character:rename": "E",
  "character:change_type": "E",
  "character:set_members": "E",
  "character:edit_gender": "E",
  "character:edit_biography": "E",
  "character:edit_role_type": "E",
  // production → 批F
  "production:mount": "F",
  "production:unmount": "F",
  // asset → 批D
  "asset:create": "D",
  "asset:rename": "D",
  "asset:overwrite": "D",
  "asset:change_type": "D",
  "asset:delete": "D",
  "asset:mount": "D",
  "asset:unmount": "D",
  // scene → 批E
  "scene:view": "E",
  // character → 批E
  "character:view": "E",
  // script → 批E
  "script:view": "E",
  // contacts → 批F
  "contacts:view": "F",
  // asset → 批D
  "asset:view": "D",
  "asset:download": "D",
  "asset:download_any": "D",
  "asset:share": "D",
  "asset:share_downloadable": "D",
  "asset:share_any": "D",
  "asset:share_any_downloadable": "D",
  // script → 批E
  "script:comment": "E",
  // org → 批G
  "org:assign_member": "G",
  "org:recall_member": "G",
};

/** 已退役键：源码中不得再出现（棘轮测试逐文件扫描字符串）。每批完成时追加。 */
export const RETIRED_PERMISSION_KEYS: readonly string[] = [
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
  "asset:mount": "D", "asset:manage": "D",
  "scene:mount": "E", "scene:manage": "E",
  "script_view:manage": "E",
};
