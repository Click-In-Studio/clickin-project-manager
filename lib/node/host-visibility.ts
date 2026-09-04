import { getPool } from "../pg";
import { hasGrant, hasAnyGrant, listGrantedResourceIds, type GrantActor } from "../grant-check";
import { hasEventDomainView, isEventGroupParticipant } from "../event-permissions";

// ─── 挂载让渡判定核（内容面，#420 第二批 PR-A）────────────────────────────────
//
// 「挂载 = 向宿主受众分享」：node 被挂到某宿主上，宿主对该用户可见 ⇒ 该 node 的
// 内容对其可读。wiki / asset 两个内容域**同源消费**本判定（asset 侧另有能力票
// 合取、wiki 侧是纯析取通道，各归各的 perm 模块）——宿主可见性只算一份，单点与
// 集合式都从这里走，不得在域内另写。
//
// 硬不变量照旧：边不投**枚举**票——本判定只进 canViewWiki / canViewAsset 的内容
// 面，listEnumerableNodeIds 不认挂载边。
//
// 通道与宿主可见锚（每种挂载点「能看到宿主的哪个面」才算接收让渡）：
//   · block/comment → script */blocks@view（剧本读者）
//   · scene         → scene meta@view（任一实例或通配）
//   · cue           → 所在 cue_list 的 cues@view（mount_id 是稳定 cue_id）
//   · event         → canEnterEvent 同判据：event 域 view ∨ 组参与（组参与带
//                     冻结语义，走应用层逐 event 判定，**不得**在 SQL 里复刻）
//   · embed         → 不在本核内：它是 asset 特有通道（文档可见 ⇒ 正文图可见，
//                     走 listVisibleWikiIds）；wiki 嵌 wiki 不支持，放进来会让
//                     wiki 可见性判定自递归。
//   · event_schedule/task/event_report 挂载类型暂无让渡通道（与迁移前行为一致）。

export const SCRIPT_MOUNT_TYPES = ["block", "comment"];
export const SCENE_MOUNT_TYPES = ["scene"];
export const CUE_MOUNT_TYPES = ["cue"];
export const EVENT_MOUNT_TYPES = ["event"];

type MountRow = { node_id: string; mount_type: string; mount_id: string };

/** 取判定范围内的挂载边：指定 node 集（单点判定传单元素数组），或按内容域全量
 *  （集合式判定）。 */
async function fetchMounts(
  productionId: string,
  filter: { nodeIds: string[] } | { kind: "asset" | "wiki" },
): Promise<MountRow[]> {
  const pool = getPool();
  if ("nodeIds" in filter) {
    if (filter.nodeIds.length === 0) return [];
    const { rows } = await pool.query<MountRow>(
      `SELECT nm.node_id, nm.mount_type, nm.mount_id
       FROM node_mount nm WHERE nm.production_id = $1 AND nm.node_id = ANY($2::text[])`,
      [productionId, filter.nodeIds],
    );
    return rows;
  }
  const targetCol = filter.kind === "asset" ? "n.asset_id" : "n.wiki_id";
  const { rows } = await pool.query<MountRow>(
    `SELECT nm.node_id, nm.mount_type, nm.mount_id
     FROM node_mount nm JOIN node n ON n.id = nm.node_id
     WHERE nm.production_id = $1 AND ${targetCol} IS NOT NULL`,
    [productionId],
  );
  return rows;
}

/**
 * 让渡成立的 node id 集合：这些 node 至少有一条挂载边、其宿主对该用户可见。
 * admin/owner 旁路在各内容域判定顶端，本函数不重复。
 */
export async function mountConcededNodeIds(
  actor: GrantActor,
  productionId: string,
  filter: { nodeIds: string[] } | { kind: "asset" | "wiki" },
): Promise<Set<string>> {
  const mounts = await fetchMounts(productionId, filter);
  const conceded = new Set<string>();
  if (mounts.length === 0) return conceded;

  const scriptMounts = mounts.filter(m => SCRIPT_MOUNT_TYPES.includes(m.mount_type));
  if (scriptMounts.length > 0
      && await hasGrant(actor.userId, productionId, "script", "*", "blocks", "view")) {
    for (const m of scriptMounts) conceded.add(m.node_id);
  }

  const sceneMounts = mounts.filter(m => SCENE_MOUNT_TYPES.includes(m.mount_type));
  if (sceneMounts.length > 0
      && await hasAnyGrant(actor.userId, productionId, "scene", ["meta"], "view")) {
    for (const m of sceneMounts) conceded.add(m.node_id);
  }

  const cueMounts = mounts.filter(m => CUE_MOUNT_TYPES.includes(m.mount_type));
  if (cueMounts.length > 0) {
    // mount_id 是稳定 cue_id（revision 行可能多条，DISTINCT 到 cue_list 粒度）；
    // production 归属经 cue_list 校验，别让外剧组 id 触发让渡。
    const listRes = await getPool().query<{ cue_id: string; cue_list_id: string }>(
      `SELECT DISTINCT c.cue_id, c.cue_list_id
       FROM cue c JOIN cue_list cl ON cl.id = c.cue_list_id
       WHERE cl.production_id = $1 AND c.cue_id = ANY($2::text[])`,
      [productionId, [...new Set(cueMounts.map(m => m.mount_id))]],
    );
    const granted = await listGrantedResourceIds(actor.userId, productionId, "cue_list", "cues", "view");
    const visibleCueIds = new Set(
      listRes.rows
        .filter(r => granted.wildcard || granted.ids.includes(r.cue_list_id))
        .map(r => r.cue_id),
    );
    for (const m of cueMounts) {
      if (visibleCueIds.has(m.mount_id)) conceded.add(m.node_id);
    }
  }

  const eventMounts = mounts.filter(m => EVENT_MOUNT_TYPES.includes(m.mount_type));
  if (eventMounts.length > 0) {
    const evRes = await getPool().query<{ id: string }>(
      `SELECT id FROM production_event WHERE production_id = $1 AND id = ANY($2::text[])`,
      [productionId, [...new Set(eventMounts.map(m => m.mount_id))]],
    );
    const inProd = [...new Set(evRes.rows.map(r => r.id))];
    const domainView = await hasEventDomainView(actor, productionId);
    const visibleEventIds = new Set<string>();
    if (domainView) {
      for (const id of inProd) visibleEventIds.add(id);
    } else if (inProd.length > 0 && await mightBeGroupParticipant(actor.userId)) {
      // 组参与冻结语义在 isEventGroupParticipant 里单份持有，不在 SQL 里复刻——
      // 代价是按 event 逐个判。集合式路径（kind 过滤）的扇出由两道闸兜住：
      // domainView 早退（列表重度用户的常态）+ 上面的超集预筛；余下并行判。
      const results = await Promise.all(
        inProd.map(async id => [id, await isEventGroupParticipant(id, actor.userId)] as const),
      );
      for (const [id, ok] of results) {
        if (ok) visibleEventIds.add(id);
      }
    }
    for (const m of eventMounts) {
      if (visibleEventIds.has(m.mount_id)) conceded.add(m.node_id);
    }
  }

  return conceded;
}

/** 组参与的**超集预筛**（只用于否定早退，不承担判定语义）：用户在全库连一行
 *  组成员（本人或经部门）/冻结快照记录都没有 ⇒ 不可能是任何 event 的组参与者，
 *  逐 event 循环整个跳过。正向判定仍归 isEventGroupParticipant（两通道 + 冻结
 *  语义单份持有）。 */
async function mightBeGroupParticipant(userId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM event_group_member egm
     LEFT JOIN production_dept_member pdm
            ON pdm.dept_id = egm.dept_id AND pdm.user_id = $1
     WHERE egm.user_id = $1 OR pdm.user_id IS NOT NULL
     UNION ALL
     SELECT 1 FROM event_group_freeze_member WHERE user_id = $1
     LIMIT 1`,
    [userId],
  );
  return rows.length > 0;
}
