/**
 * scene 字段门的纯层（无 pg 依赖，客户端组件可直接 import）。
 *
 * 与 lib/member-status-shared.ts 同一约定：canDeleteScene 要在浏览器里逐行跑，
 * 而 lib/scene-field-perms.ts 连着 pg 进不了浏览器包。谓词只写一遍，两侧同源。
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
export type SceneGrantRow = { resource_id: string; resource_sub: string; permission_level: string };

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
  /** 域级 delete（resource_id='*'）——对所有场次生效 */
  delete: boolean;
  /** 实例级 delete 例外：只在这些 sceneId 上额外持有。判定端 DELETE 查的是
   *  `resource_id IN (sceneId, '*')`，而字段 PATCH 只查 '*'，故 delete 与 mounts
   *  这两个「按实例判」的动作各有一层 ids。 */
  deleteIds: string[];
  /** 域级挂载：把素材挂到场次上（node:scene/*\/mounts@create）。字段写权限不蕴含
   *  它——构作页的挂载区此前用 `any` 粗门开合，持 music@edit 的作曲看得见入口、
   *  点下去被 mountHostSidePermitted 挡成 403。 */
  mounts: boolean;
  /** 实例级挂载例外（判定端同样查 `resource_id IN (sceneId, '*')`）。 */
  mountIds: string[];
  /** 结构面：重排、归属变更 */
  structure: boolean;
  any: boolean;
};

export const ALL_SCENE_FIELD_PERMS: SceneFieldPerms = {
  name: true, kind: true, synopsis: true, actionLine: true,
  music: true, stageNotes: true, expectedDuration: true,
  create: true, delete: true, deleteIds: [], mounts: true, mountIds: [],
  structure: true, any: true,
};

export const NO_SCENE_FIELD_PERMS: SceneFieldPerms = {
  name: false, kind: false, synopsis: false, actionLine: false,
  music: false, stageNotes: false, expectedDuration: false,
  create: false, delete: false, deleteIds: [], mounts: false, mountIds: [],
  structure: false, any: false,
};

/** 逐实例判定：域级 delete 覆盖全部场次，实例级行只覆盖它自己那一个。 */
export function canDeleteScene(perms: SceneFieldPerms, sceneId: string): boolean {
  return perms.delete || perms.deleteIds.includes(sceneId);
}

/** 逐实例判定：域级挂载覆盖全部场次，实例级行只覆盖它自己那一个。
 *  与后端 mountHostSidePermitted 的 `hasGrant(scene, mountId, "mounts", "create")` 同源。 */
export function canMountScene(perms: SceneFieldPerms, sceneId: string): boolean {
  return perms.mounts || perms.mountIds.includes(sceneId);
}

/**
 * 一次查询取全部 scene 写权限。
 *
 * 逐字段调 hasGrant 会是 10 次往返，而构作页每次渲染都要算一遍——这里拉一次
 * scene 域的行，在内存里按 hasGrant 的匹配语义（id ∈ {'*'}、sub ∈ {sub,'*'}）
 * 判各字段。
 */
export function sceneFieldPermsFromRows(rows: readonly SceneGrantRow[]): SceneFieldPerms {
  // 域级行：字段 PATCH / create 判定端查的都是 resource_id = '*'，实例级行在那
  // 两条路上根本不命中，所以不能拿它去点亮字段门。
  const domain = rows.filter(r => r.resource_id === "*");
  const has = (sub: string, verb: string): boolean =>
    domain.some(r => (r.resource_sub === sub || r.resource_sub === "*") && r.permission_level === verb);

  const perms = {
    create: has("*", "create"),
    delete: has("*", "delete"),
    deleteIds: [...new Set(
      rows
        .filter(r => r.resource_id !== "*" && r.resource_sub === "*" && r.permission_level === "delete")
        .map(r => r.resource_id),
    )],
    mounts: has("mounts", "create"),
    // 挂载的 sub 不是保留段，故实例级行的 sub 命中 'mounts' 与 '*' 两种形态
    mountIds: [...new Set(
      rows
        .filter(r => r.resource_id !== "*" && r.permission_level === "create"
          && (r.resource_sub === "mounts" || r.resource_sub === "*"))
        .map(r => r.resource_id),
    )],
    structure: has("*", "edit"),
  } as SceneFieldPerms;
  for (const [field, sub] of Object.entries(SCENE_FIELD_SUBS)) {
    perms[field as SceneField] = has(sub, "edit");
  }
  perms.any = Object.entries(perms).some(
    ([k, v]) => k !== "any" && (Array.isArray(v) ? v.length > 0 : v),
  );
  return perms;
}
