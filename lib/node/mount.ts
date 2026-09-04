import { getPool } from "../pg";
import { uid, rowToAsset, type Asset, type AssetRow } from "../asset/db";

// ─── 简单通用挂载边 node_mount（原 asset_mount，#420 演化）──────────────────
//
// 【边的哲学】挂载边是**关系概念不是一张表**：不同业务的边有不同特性，各自建表
// 各归业务域所有（event_report 的三元关系就是现成样本）。本表只是「还没长出
// 个性」的缺省简单边种——业务复杂度到了就从这里毕业成专表，并在下面的
// reference resolver 注册表登记。
//
// 【node 契约】任何边种（含本表）必须遵守：
//   1. 以 node id 寻址；node 侧不知道有哪些边种。
//   2. 悬空即删：读路径 join 目标，解析不到不出现（宿主侧 mount_id 多态无 FK，
//      宿主删除的悬空行由「反向查询只从活宿主页发起」遮蔽；node 侧真 FK CASCADE）。
//   3. 【硬不变量】**边不投枚举票**：任何边种不得让节点在目录树里出现。内容面的
//      挂载让渡＝分享语义（资产挂到可见 scene ⇒ 内容可见，如同 wiki 被分享后
//      父链不可枚举也看不到位置但能读）——宿主可见性判定收敛在
//      lib/node/host-visibility.ts 共享核，wiki/asset 内容面同源消费；
//      不进 node/perm 的任何谓词。
//
// mount_type='embed'：wiki 正文嵌入的图片资产，宿主 mount_id=wiki uuid（内容面
// 寻址——嵌入属于正文不属于树）。「文档可见⇒图可见」语义即原 'wiki' mount。

export type MountType =
  | "scene" | "block" | "cue"
  | "comment" | "event" | "event_schedule" | "task" | "event_report"
  | "embed";

export type NodeMount = {
  id: string;
  nodeId: string;
  productionId: string;
  mountType: MountType;
  mountId: string;
  mountAuxId: string | null;
  createdBy: string;
  createdAt: string;
};

type NodeMountRow = {
  id: string; node_id: string; production_id: string; mount_type: string;
  mount_id: string; mount_aux_id: string | null;
  created_by: string; created_at: Date;
};

function rowToMount(r: NodeMountRow): NodeMount {
  return {
    id: r.id, nodeId: r.node_id, productionId: r.production_id,
    mountType: r.mount_type as MountType, mountId: r.mount_id, mountAuxId: r.mount_aux_id,
    createdBy: r.created_by, createdAt: r.created_at.toISOString(),
  };
}

export async function addNodeMount(params: {
  nodeId: string;
  productionId: string;
  mountType: MountType;
  mountId: string;
  mountAuxId?: string | null;
  createdBy: string;
}): Promise<NodeMount> {
  const id = uid("am");
  const res = await getPool().query<NodeMountRow>(
    `INSERT INTO node_mount (id, node_id, production_id, mount_type, mount_id, mount_aux_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [id, params.nodeId, params.productionId, params.mountType, params.mountId,
     params.mountAuxId ?? null, params.createdBy]
  );
  return rowToMount(res.rows[0]);
}

export async function removeNodeMount(mountId: string): Promise<void> {
  await getPool().query(`DELETE FROM node_mount WHERE id = $1`, [mountId]);
}

export async function getNodeMount(mountId: string): Promise<NodeMount | null> {
  const res = await getPool().query<NodeMountRow>(
    `SELECT * FROM node_mount WHERE id = $1`, [mountId]);
  return res.rows[0] ? rowToMount(res.rows[0]) : null;
}

export async function listNodeMounts(nodeId: string): Promise<NodeMount[]> {
  const res = await getPool().query<NodeMountRow>(
    `SELECT * FROM node_mount WHERE node_id = $1 ORDER BY created_at DESC`, [nodeId]);
  return res.rows.map(rowToMount);
}

/** 挂载点读面的泛化形状（#420 第二批）：一条边 + 目标 node 的 kind 分派载荷。
 *  asset 节点带 asset 全行；wiki 节点带 {id, title}；folder/link 不可挂载
 *  （但读路径不假设，遇到即只回 node 骨架）。 */
export type MountedNodeEntry = {
  mount: NodeMount;
  nodeId: string;
  kind: string;
  asset: Asset | null;
  wiki: { id: string; title: string | null } | null;
};

/** 某挂载点上的全部节点（含边行），按 kind 分派载荷。**不带权限过滤**——
 *  调用方按 kind 走各自内容面（asset→filterVisibleAssets，wiki→canViewWiki/
 *  listVisibleWikiIds），别在这里加门。 */
export async function listNodesByMountPoint(
  productionId: string,
  mountType: MountType,
  mountId: string,
  mountAuxId?: string | null
): Promise<MountedNodeEntry[]> {
  const params: (string | null)[] = [productionId, mountType, mountId];
  const auxClause = mountAuxId !== undefined ? " AND nm.mount_aux_id = $4" : "";
  if (mountAuxId !== undefined) params.push(mountAuxId ?? null);

  const res = await getPool().query<NodeMountRow & {
    target_node_id: string; kind: string;
    asset: AssetRow | null;
    wiki_id: string | null; wiki_title: string | null;
  }>(
    `SELECT nm.*, n.id AS target_node_id, n.kind,
            row_to_json(a.*) AS asset,
            w.id::text AS wiki_id, w.title AS wiki_title
     FROM node_mount nm
     JOIN node n ON n.id = nm.node_id
     LEFT JOIN asset a ON a.id = n.asset_id
     LEFT JOIN wiki w ON w.id = n.wiki_id
     WHERE nm.production_id = $1 AND nm.mount_type = $2 AND nm.mount_id = $3${auxClause}
     ORDER BY nm.created_at DESC`,
    params
  );
  return res.rows.map(r => ({
    mount: rowToMount(r),
    nodeId: r.target_node_id,
    kind: r.kind,
    asset: r.asset
      ? rowToAsset({ ...r.asset, created_at: new Date(r.asset.created_at as unknown as string) })
      : null,
    wiki: r.wiki_id ? { id: r.wiki_id, title: r.wiki_title } : null,
  }));
}

/** 某挂载点上的全部资产（含边行）——listNodesByMountPoint 的 asset 面投影，
 *  现有资产面板消费此形状。 */
export async function getAssetsByMountPoint(
  productionId: string,
  mountType: MountType,
  mountId: string,
  mountAuxId?: string | null
): Promise<Array<{ mount: NodeMount; asset: Asset }>> {
  const entries = await listNodesByMountPoint(productionId, mountType, mountId, mountAuxId);
  return entries.flatMap(e => (e.asset ? [{ mount: e.mount, asset: e.asset }] : []));
}

// ─── 跨边种反查 resolver 注册表 ─────────────────────────────────────────────
//
// 边种去中心化后，「该 node 被谁引用」没有单一表可查——每种边注册一个查询函数，
// 服务 deleteNode 的删除守卫、node 详情「被引用处」面板、AI 问答。应用层现查、
// 不物化（同 dept_share「判定时查、零 sweep」的仓库定式）。

export type NodeReference = {
  /** 边种标识（'node_mount' / 'event_report' / 'event_report_note' / …） */
  edgeKind: string;
  /** 人话标签（「挂载：scene」「作为报告挂在 <event>」…由各边种自拟） */
  label: string;
  /** 引用方业务 id（宿主），供 UI 拼跳转 */
  hostType: string;
  hostId: string;
};

type NodeReferenceResolver = (nodeId: string, productionId: string) => Promise<NodeReference[]>;

const REFERENCE_RESOLVERS = new Map<string, NodeReferenceResolver>();

export function registerNodeReferenceResolver(edgeKind: string, resolver: NodeReferenceResolver): void {
  REFERENCE_RESOLVERS.set(edgeKind, resolver);
}

/** 全边种反查（N 个索引点查，N=边种数，个位数——不物化的代价可忽略）。 */
export async function listNodeReferences(nodeId: string, productionId: string): Promise<NodeReference[]> {
  const out: NodeReference[] = [];
  for (const resolver of REFERENCE_RESOLVERS.values()) {
    out.push(...await resolver(nodeId, productionId));
  }
  return out;
}

// 本表自己的 resolver
registerNodeReferenceResolver("node_mount", async (nodeId, productionId) => {
  const mounts = await listNodeMounts(nodeId);
  return mounts
    .filter(m => m.productionId === productionId)
    .map(m => ({
      edgeKind: "node_mount",
      label: `挂载：${m.mountType}`,
      hostType: m.mountType,
      hostId: m.mountId,
    }));
});
