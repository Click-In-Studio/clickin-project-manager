/**
 * scene 字段门的单一事实源（2026-08-17）。
 *
 * 总表 §0「字段写权限挂 meta 下」：scene 的每个可写字段各有一把钥匙，
 * 项目模版（原 grant_template）也是逐字段发的。这里把「字段 → 节点 sub」的映射集中一处，
 * 三个消费方共用，避免再次出现模板与判定各说各话：
 *
 *   - app/api/production/[id]/scenes/[sceneId]  构作页 REST 的逐字段门
 *   - lib/script-ops.ts                          剧本页 patch 的 marker 字段门
 *   - app/production/[id]/dramaturgy             前端按字段禁用编辑态
 *
 * 曾经这里只有一把 meta/name@edit 总钥匙，而模板发的是 synopsis@edit 之类，
 * 两边永不相交——作曲想改 music 实际要的是改名权，而改名权模板从没发过。
 */
import { getPool } from "./pg";

export const SCENE_FIELD_SUBS = {
  name: "meta/name",
  kind: "meta/type",
  synopsis: "synopsis",
  actionLine: "action_line",
  music: "music",
  stageNotes: "stage_notes",
  expectedDuration: "meta/expected_duration",
} as const;

export type SceneField = keyof typeof SCENE_FIELD_SUBS;

/** body 里真正带了改动的字段（未出现的字段不判权限，不做无谓的拒绝）。 */
export function touchedSceneFields(body: Record<string, unknown>): SceneField[] {
  const touched: SceneField[] = [];
  if (body.kind === "chapter" || body.kind === "scene") touched.push("kind");
  if (typeof body.name === "string") touched.push("name");
  for (const field of ["synopsis", "actionLine", "music", "stageNotes", "expectedDuration"] as const) {
    if (typeof body[field] === "string") touched.push(field);
  }
  return touched;
}

/** 前端按字段禁用编辑态用的权限快照。`any` = 是否值得显示编辑态外壳。 */
export type SceneFieldPerms = Record<SceneField, boolean> & {
  create: boolean;
  delete: boolean;
  /** 结构面：重排、归属变更 */
  structure: boolean;
  any: boolean;
};

export const ALL_SCENE_FIELD_PERMS: SceneFieldPerms = {
  name: true, kind: true, synopsis: true, actionLine: true,
  music: true, stageNotes: true, expectedDuration: true,
  create: true, delete: true, structure: true, any: true,
};

export const NO_SCENE_FIELD_PERMS: SceneFieldPerms = {
  name: false, kind: false, synopsis: false, actionLine: false,
  music: false, stageNotes: false, expectedDuration: false,
  create: false, delete: false, structure: false, any: false,
};

/**
 * 一次查询取全部 scene 写权限。
 *
 * 逐字段调 hasGrant 会是 10 次往返，而构作页每次渲染都要算一遍——这里拉一次
 * scene 域的行，在内存里按 hasGrant 的匹配语义（id ∈ {'*'}、sub ∈ {sub,'*'}）
 * 判各字段。
 */
export async function getSceneFieldPerms(
  userId: string,
  productionId: string,
  bypass: boolean,
): Promise<SceneFieldPerms> {
  if (bypass) return ALL_SCENE_FIELD_PERMS;

  const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
    `SELECT resource_sub, permission_level FROM production_member_grant
     WHERE production_id = $1 AND user_id = $2 AND resource_type = 'scene'
       AND resource_id = '*' AND NOT is_revoked
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [productionId, userId],
  );

  const has = (sub: string, verb: string): boolean =>
    rows.some(r => (r.resource_sub === sub || r.resource_sub === "*") && r.permission_level === verb);

  const perms = {
    create: has("*", "create"),
    delete: has("*", "delete"),
    structure: has("*", "edit"),
  } as SceneFieldPerms;
  for (const [field, sub] of Object.entries(SCENE_FIELD_SUBS)) {
    perms[field as SceneField] = has(sub, "edit");
  }
  perms.any = Object.entries(perms).some(([k, v]) => k !== "any" && v);
  return perms;
}
