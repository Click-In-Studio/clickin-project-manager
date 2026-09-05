import { getPool } from "../pg";
import { hasGrant, listGrantedResourceIds, type GrantActor } from "../grant-check";
import { isNodeAnchor } from "./anchors";

// ─── 枚举面（#357 → #420 node 化）：目录树可见性，与各内容面正交 ──────────────
//
//   可枚举(u, X) ⟺ 可枚举(u, parent(X)) ∧ 本地可枚举(u, X)
//   本地可枚举(u, X) ⟺
//     kind∈{folder,wiki,asset}: X.listable ∨ 部门分享命中
//       ∨ (kind='wiki' 且 u 持 wiki/<wiki_id> meta@view 行（含通配）)
//     kind='link': 不进本谓词——父可枚举 ∧ 目标**本地**可枚举（lib/node/link.ts）
//
// 拍板记录（#420）：
//   · asset 节点**无 grant 析取项**（2026-09-04 拍板 6「漂移一不接受」）：持某资产
//     实例 meta@view 票不使它进树——定向分享的私有资产靠链接/publication 直达，
//     行为与迁移前全等。资产进树的途径：listable（原 production mount 语义）、
//     部门分享，或**自己是创建者**（下条）。
//   · **创建者析取项**（2026-09-05 拍板，拍板 6 的精化）：asset 节点对其
//     created_by 本人可枚举——自己看不到自己刚上传的私有资产是反直觉的，且与
//     wiki 侧不对称（wiki 创建者行集的 meta@view 经 grant 析取天然进树）。按
//     created_by 判而非发 grant 行：不碰授权语义，「定向分享不进树」原样成立。
//   · grant 行键在**内容域**（'wiki'/uuid）不迁：$2 数组是应用侧预取的 wiki
//     meta@view 内容 id，谓词里对撞 node.wiki_id 目标列。`*@view` sub 通配天然
//     命中 meta 的零迁移蕴含（grant-check `resource_sub IN ($5,'*')`）原样成立。
//   · **wildcard 早退已删**：合树后 wiki 通配不覆盖 asset/folder 节点，「每个节点
//     都过第二合取项」的老论证失效——通配折进谓词（$4），CTE 恒跑。admin/owner
//     早退保留（全站不变量）。
//   · 边不投枚举票（硬不变量）：任何边种不出现在本谓词。内容面的挂载让渡＝分享
//     语义，由各内容域判定自持（asset/perm、wiki/perm）。
//
// 前置合取项即不变量 E(子) ⊆ E(父)：任何人看到的都是含根连通子树，隐一个节点即
// 隐整棵子树，零级联写、不可能漂移。沿祖先链求交、永不物化（§0.9）。
//
// **本面只写这一份实现**（集合式），单点判定＝查集合（#357 症状③ 双写教训）。

/**
 * 本地可枚举谓词，SQL 片段**只写这一份**。两个读者：下面的递归 CTE 与
 * localEnumerableNodeIds（#358 link 判定的第二合取项）。
 * 参数位固定：$1=production_id、$2=wiki meta@view 内容 id 数组、$3=user_id、
 * $4=wiki meta@view 通配布尔。表别名固定 `n`。
 */
const LOCAL_ENUMERABLE_PRED = `(
     (n.kind <> 'link' AND n.listable)
  OR (n.kind = 'wiki' AND ($4 OR n.wiki_id::text = ANY($2::text[])))
  OR (n.kind = 'asset' AND n.created_by = $3::uuid)
  OR (n.kind <> 'link' AND EXISTS (
        SELECT 1 FROM node_dept_share ns
        JOIN production_dept_member pdm ON pdm.dept_id = ns.dept_id
        WHERE ns.node_id = n.id AND pdm.user_id = $3::uuid
          AND pdm.production_id = $1)))`;

export async function listEnumerableNodeIds(
  actor: GrantActor,
  productionId: string,
): Promise<{ wildcard: boolean; ids: Set<string> }> {
  if (actor.isAdmin || actor.isOwner) return { wildcard: true, ids: new Set() };
  const granted = await listGrantedResourceIds(actor.userId, productionId, "wiki", "meta", "view");
  const ids = granted.wildcard ? [] : [...granted.ids];
  const { rows } = await getPool().query<{ id: string }>(
    `WITH RECURSIVE local AS (
       SELECT n.id, n.parent_id, ${LOCAL_ENUMERABLE_PRED} AS ok
       FROM node n WHERE n.production_id = $1 AND n.kind <> 'link'
     ),
     enumerable AS (
       SELECT l.id, 1 AS depth FROM local l WHERE l.parent_id IS NULL AND l.ok
       UNION ALL
       SELECT c.id, e.depth + 1 FROM local c JOIN enumerable e ON c.parent_id = e.id
       WHERE e.depth < 100 AND c.ok
     )
     SELECT DISTINCT id FROM enumerable`,
    [productionId, ids, actor.userId, granted.wildcard],
  );
  return { wildcard: false, ids: new Set(rows.map(r => r.id)) };
}

/** 单点枚举判定＝查集合（刻意不另写上溯 SQL）。link 节点用 link.ts 的全式。 */
export async function canEnumerateNode(
  actor: GrantActor, productionId: string, nodeId: string,
): Promise<boolean> {
  const e = await listEnumerableNodeIds(actor, productionId);
  return e.wildcard || e.ids.has(nodeId);
}

/**
 * **本地**可枚举筛选（link 判定式第二合取项）：候选 node id 中「目标自身允许被
 * 列出」的那些——只跑本地谓词，不含目标祖先链。判据来由见 #358：软链接给目标的
 * 是第二个位置，位置维由链接自己的父链承担；改成全可枚举会让「把私密子树里的
 * 一篇提到灵感库」当场失效。
 */
export async function localEnumerableNodeIds(
  actor: GrantActor, productionId: string, candidateIds: string[],
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  if (actor.isAdmin || actor.isOwner) return new Set(candidateIds);
  const granted = await listGrantedResourceIds(actor.userId, productionId, "wiki", "meta", "view");
  const ids = granted.wildcard ? [] : [...granted.ids];
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT n.id FROM node n
     WHERE n.production_id = $1 AND n.id = ANY($5::text[]) AND ${LOCAL_ENUMERABLE_PRED}`,
    [productionId, ids, actor.userId, granted.wildcard, candidateIds],
  );
  return new Set(rows.map(r => r.id));
}

/** 落位门之一（枚举面）：只能把节点挂到自己能枚举的父下。null=顶层恒允许。 */
export async function canPlaceNodeUnder(
  actor: GrantActor, productionId: string, parentId: string | null,
): Promise<boolean> {
  if (parentId === null) return true;
  return canEnumerateNode(actor, productionId, parentId);
}

/**
 * 落位门之二（写面）：容器写权。只认直接父、不沿祖先链继承。
 *
 * 豁免（依次）：
 *   · parentId=null（顶层）：根容器上不存在「edit 权」这个说法（#357 论证原文）
 *   · admin/owner
 *   · kind='folder'：**第一批已知让步**——folder 无内容域可挂 grant，且现存
 *     folder 全部是无主的系统产物（资产根 + folder_path 展开链），比照锚点豁免。
 *     第二批 folder 开放用户自建时引入 node 域行再收紧。
 *   · 系统锚点：无主公共容器（isNodeAnchor 头注释）
 * 其余（wiki 容器）：父文档的 wiki/<wiki_id> `*@edit`（内容域键，`*@edit`
 * 通配命中任何子段的零迁移手法照旧）。
 */
export async function canWriteNodeContainer(
  actor: GrantActor, productionId: string, parentId: string | null,
): Promise<boolean> {
  if (parentId === null) return true;
  if (actor.isAdmin || actor.isOwner) return true;
  const { rows } = await getPool().query<{ kind: string; wiki_id: string | null }>(
    `SELECT kind, wiki_id::text AS wiki_id FROM node WHERE id = $1 AND production_id = $2`,
    [parentId, productionId],
  );
  const parent = rows[0];
  if (!parent) return false;
  if (parent.kind === "folder") return true;
  if (await isNodeAnchor(parentId)) return true;
  if (parent.kind === "wiki" && parent.wiki_id) {
    return hasGrant(actor.userId, productionId, "wiki", parent.wiki_id, "*", "edit");
  }
  return false;
}
