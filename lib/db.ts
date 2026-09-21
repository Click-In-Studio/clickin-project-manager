export type { UserInfo } from "./account/db-feishu";
export { upsertFeishuUser, getFeishuUser, attachFeishuToUser, getFeishuOpenId, batchGetFeishuOpenIds } from "./account/db-feishu";

// 角色名单（ROLE_NAMES）已上移为项目模版的一个 slot，见 lib/production/production-template.ts

// ─── 转发壳（#486 分家过渡期）──────────────────────────────────────────────────
// 搬出去的段只留 `export *`，让 386 个 importer 不必跟着每个搬运 PR 改路径；
// 全部搬完后最后一个 PR 脚本改写 import 到深路径并删壳。壳里不许再长函数。

export * from "./approval/access-request-db";
export * from "./approval/access-request-action-db";
export * from "./ops/milestone-db";
export * from "./notify/announcement-db";
export * from "./ops/cue-list-db";
export * from "./ops/cue-db";
export * from "./perm/role-db";
export * from "./perm/permission-context-db";
export * from "./perm/member-db";
export * from "./script/version-db";
export * from "./script/script-view-db";
export * from "./production/production-db";
export * from "./account/user-db";
export * from "./account/email-auth-db";
export * from "./ops/comment-db";
export * from "./script/script-marker-label-db";
export * from "./script/script-block-read-db";
export * from "./script/page-map-db";
export * from "./script/script-scene-character-db";
export * from "./script/script-block-tag-db";
export * from "./script/script-state-db";
export * from "./script/script-version-content-db";
export * from "./script/script-import-db";
export * from "./script/script-patch-db";
