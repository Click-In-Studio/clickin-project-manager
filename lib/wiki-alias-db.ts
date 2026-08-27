import { getPool } from "./pg";
import { broadcastWikiLibraryChange } from "./wiki-collab";
import { tailSortKey, placementSortKey, type WikiPlacement } from "./wiki-db";
import { canViewWiki, localEnumerableWikiIds } from "./wiki-perm";
import type { GrantActor } from "./grant-check";

// ─── wiki 软链接（#358）：目录树里指向目标的伪节点 ─────────────────────────────
//
// 别名有自己的 id / parent_id / sort_key，内容指向 target。「同一篇文档出现在多处」
// 由多个指向同一目标的别名表达——wiki 行之间仍是标准树，每行只有一个 parent_id。
//
// 【别名只链一篇文档，不是链一棵子树】别名是**叶子**：它下面不展开目标的任何子
// 文档，也不能在它下面新建。于是防环退化成非问题（没有路径能穿过别名），路由/
// 上下文也不会跳出当前工作区。
//
// 【不可让步】别名不是授权面。表上没有 listable/is_public，不接受 grant 行：
//   可枚举(u, 别名) ⟺ 可枚举(u, 别名的父) ∧ 本地可枚举(u, 目标)
//   读正文        ⟺ 目标自己的内容门（wiki 目标即 canViewWiki）
// 第二合取项是**本地**可枚举——目标自身的 listable / meta@view 行 / 部门分享，
// 不含目标那条祖先链。理由见 wiki-perm.localEnumerableWikiIds 头注释。
//
// 目标多态：每种 target_type 只需实现下面这三件事。本批只接 'wiki'，asset 等待接入
// （asset 侧已有 asset_mount 的挂载面，接入时要先说清两者分工：asset_mount 管资产库
// 里的归属，wiki_alias 管「出现在文档树的哪个位置」）。

export type WikiAliasTargetType = "wiki";

type AliasTargetResolver = {
  /** 存在且属于本 production 的目标 → 标题。解析不到的 id 直接不进 Map。 */
  titles(productionId: string, ids: string[]): Promise<Map<string, string | null>>;
  /** 判定式第二合取项：目标**自身**允许被列出的那些（不含目标的祖先链）。 */
  locallyEnumerable(actor: GrantActor, productionId: string, ids: string[]): Promise<Set<string>>;
  /** 内容门：能不能读目标正文。 */
  canReadContent(actor: GrantActor, productionId: string, id: string): Promise<boolean>;
};

const RESOLVERS: Record<string, AliasTargetResolver> = {
  wiki: {
    async titles(productionId, ids) {
      const { rows } = await getPool().query<{ id: string; title: string | null }>(
        `SELECT id::text AS id, title FROM wiki
         WHERE production_id = $1 AND id::text = ANY($2::text[])`,
        [productionId, ids],
      );
      return new Map(rows.map(r => [r.id, r.title]));
    },
    locallyEnumerable: (actor, productionId, ids) => localEnumerableWikiIds(actor, productionId, ids),
    canReadContent: (actor, productionId, id) => canViewWiki(actor, productionId, id),
  },
};

export function isWikiAliasTargetType(t: string): t is WikiAliasTargetType {
  return t in RESOLVERS;
}

/** 别名 id 的形状即判别式（真实 wiki 是 UUID）——路由段一眼可辨，不需要新路由。 */
const ALIAS_ID_PREFIX = "wal_";
export function isWikiAliasId(id: string): boolean {
  return id.startsWith(ALIAS_ID_PREFIX);
}
function newAliasId(): string {
  return `${ALIAS_ID_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export type WikiAliasRow = {
  id: string;
  productionId: string;
  parentId: string | null;
  sortKey: string | null;
  targetType: string;
  targetId: string;
  /** 这个位置上的显示名；null＝跟随目标实时标题（#358 ⑤）。 */
  displayTitle: string | null;
  createdBy: string | null;
  createdAt: string;
};

/**
 * 树节点形态。`title` 是渲染用的解析结果 `displayTitle ?? targetTitle`，
 * `targetTitle` 单独留着——UI 要能说清"这是软链接 → 那篇叫什么"，改了显示名之后
 * 尤其需要。显示名是纯标签：不参与可枚举性判定，也不改变任何内容门。
 */
export type WikiAliasEntry = WikiAliasRow & { title: string | null; targetTitle: string | null };

const SELECT_COLS = `id, production_id, parent_id::text AS parent_id, sort_key,
                     target_type, target_id, display_title,
                     created_by::text AS created_by, created_at`;

type Row = {
  id: string; production_id: string; parent_id: string | null; sort_key: string | null;
  target_type: string; target_id: string; display_title: string | null;
  created_by: string | null; created_at: Date;
};

function toAlias(r: Row): WikiAliasRow {
  return {
    id: r.id, productionId: r.production_id, parentId: r.parent_id, sortKey: r.sort_key,
    targetType: r.target_type, targetId: r.target_id, displayTitle: r.display_title,
    createdBy: r.created_by, createdAt: r.created_at.toISOString(),
  };
}

export async function getWikiAlias(id: string, productionId: string): Promise<WikiAliasRow | null> {
  const { rows } = await getPool().query<Row>(
    `SELECT ${SELECT_COLS} FROM wiki_alias WHERE id = $1 AND production_id = $2`,
    [id, productionId],
  );
  return rows[0] ? toAlias(rows[0]) : null;
}

/** 全量别名行（未解析、未过门）。可见性过滤由调用方做——同 listWikiLibrary 的姿态。 */
export async function listWikiAliases(productionId: string): Promise<WikiAliasRow[]> {
  const { rows } = await getPool().query<Row>(
    `SELECT ${SELECT_COLS} FROM wiki_alias WHERE production_id = $1
     ORDER BY sort_key NULLS LAST, created_at`,
    [productionId],
  );
  return rows.map(toAlias);
}

/** 指向某目标的所有别名（删除前的「有几处软链接」提示 / 目标页的位置列表）。 */
export async function listAliasesForTarget(
  productionId: string, targetType: string, targetId: string,
): Promise<WikiAliasRow[]> {
  const { rows } = await getPool().query<Row>(
    `SELECT ${SELECT_COLS} FROM wiki_alias
     WHERE production_id = $1 AND target_type = $2 AND target_id = $3
     ORDER BY created_at`,
    [productionId, targetType, targetId],
  );
  return rows.map(toAlias);
}

/**
 * 目录树里该用户能看到的别名（#358 判定式）：
 *   父可枚举（null=顶层恒真） ∧ 本地可枚举(目标) ∧ 目标解析得到
 *
 * 第三项是惰性兜底：目标已删（多态无 FK，级联不会自己发生）或跨 production 的
 * 脏行，一律不出树，不做失效占位。
 *
 * `enumerable` 由调用方传入（listEnumerableWikiIds 的结果），避免同一请求里重复
 * 跑那条递归 CTE。
 */
export async function listEnumerableWikiAliases(
  actor: GrantActor,
  productionId: string,
  enumerable: { wildcard: boolean; ids: Set<string> },
): Promise<WikiAliasEntry[]> {
  const all = await listWikiAliases(productionId);
  const placed = all.filter(a =>
    a.parentId === null || enumerable.wildcard || enumerable.ids.has(a.parentId));
  if (placed.length === 0) return [];

  const out: WikiAliasEntry[] = [];
  for (const [type, resolver] of Object.entries(RESOLVERS)) {
    const ofType = placed.filter(a => a.targetType === type);
    if (ofType.length === 0) continue;
    const ids = [...new Set(ofType.map(a => a.targetId))];
    const [titles, localOk] = await Promise.all([
      resolver.titles(productionId, ids),
      resolver.locallyEnumerable(actor, productionId, ids),
    ]);
    for (const a of ofType) {
      if (!titles.has(a.targetId) || !localOk.has(a.targetId)) continue;
      const targetTitle = titles.get(a.targetId) ?? null;
      out.push({ ...a, targetTitle, title: a.displayTitle ?? targetTitle });
    }
  }
  // 未知 target_type（将来的类型跑在旧代码上）一律不出树——静默丢弃好过误处理
  return out.sort((x, y) =>
    (x.sortKey ?? "￿").localeCompare(y.sortKey ?? "￿") || x.createdAt.localeCompare(y.createdAt));
}

/** 内容门转发：别名一票不投，永远重判目标（#358 不可让步不变量）。 */
export async function canReadAliasTarget(
  actor: GrantActor, productionId: string, alias: WikiAliasRow,
): Promise<boolean> {
  const resolver = RESOLVERS[alias.targetType];
  if (!resolver) return false;
  return resolver.canReadContent(actor, productionId, alias.targetId);
}

/** 单个别名的可枚举判定（判定式全式，供路由/工具单点使用）。 */
export async function canEnumerateWikiAlias(
  actor: GrantActor,
  productionId: string,
  alias: WikiAliasRow,
  enumerable: { wildcard: boolean; ids: Set<string> },
): Promise<boolean> {
  if (alias.parentId !== null && !enumerable.wildcard && !enumerable.ids.has(alias.parentId)) return false;
  const resolver = RESOLVERS[alias.targetType];
  if (!resolver) return false;
  const local = await resolver.locallyEnumerable(actor, productionId, [alias.targetId]);
  return local.has(alias.targetId);
}

/** 目标存在性（建别名时校验；跨 production 目标一律拒）。 */
async function targetExists(productionId: string, targetType: string, targetId: string): Promise<boolean> {
  const resolver = RESOLVERS[targetType];
  if (!resolver) return false;
  const titles = await resolver.titles(productionId, [targetId]);
  return titles.has(targetId);
}

/**
 * 别名不得建在目标自己的子树内（含目标本身）。
 *
 * 别名是叶子，所以这里**不是**防环——环经别名不可能形成。这条是防「把一篇文档
 * 软链接到它自己底下」这类无意义结构，同时给未来可能的「透读目标子树」留门：
 * 那一档一旦开，目标子树内的别名就是真的环。
 */
async function placeInsideTargetSubtree(
  productionId: string, parentId: string | null, targetType: string, targetId: string,
): Promise<boolean> {
  if (parentId === null || targetType !== "wiki") return false;
  if (parentId === targetId) return true;
  const { rows } = await getPool().query<{ hit: boolean }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_id, 1 AS depth FROM wiki WHERE id = $1::uuid AND production_id = $3
       UNION ALL
       SELECT w.id, w.parent_id, c.depth + 1 FROM wiki w JOIN chain c ON w.id = c.parent_id
       WHERE c.depth < 100
     )
     SELECT EXISTS (SELECT 1 FROM chain WHERE id = $2::uuid) AS hit`,
    [parentId, targetId, productionId],
  );
  return rows[0].hit;
}

export type WikiAliasError =
  | "target_not_found" | "parent_not_found" | "unsupported_target" | "inside_target_subtree" | "duplicate";

/** 建别名。门（容器写门/落位门/目标可枚举）由调用方在此之前跑完——同 createWiki 姿态。 */
export async function createWikiAlias(params: {
  productionId: string;
  parentId: string | null;
  targetType: string;
  targetId: string;
  createdBy: string;
  place?: WikiPlacement;
  /** 显示名（#358 ⑤）；缺省/空＝跟随目标实时标题。 */
  displayTitle?: string | null;
}): Promise<{ ok: true; alias: WikiAliasRow } | { ok: false; reason: WikiAliasError }> {
  const { productionId, parentId, targetType, targetId } = params;
  if (!isWikiAliasTargetType(targetType)) return { ok: false, reason: "unsupported_target" };
  if (!await targetExists(productionId, targetType, targetId)) return { ok: false, reason: "target_not_found" };
  if (parentId !== null) {
    const p = await getPool().query(
      `SELECT 1 FROM wiki WHERE id = $1::uuid AND production_id = $2`, [parentId, productionId]);
    if (!p.rows[0]) return { ok: false, reason: "parent_not_found" };
  }
  if (await placeInsideTargetSubtree(productionId, parentId, targetType, targetId))
    return { ok: false, reason: "inside_target_subtree" };

  const id = newAliasId();
  const sortKey = params.place
    ? await placementSortKey(productionId, parentId, params.place, null)
    : await tailSortKey(productionId, parentId);
  try {
    await getPool().query(
      `INSERT INTO wiki_alias
         (id, production_id, parent_id, sort_key, target_type, target_id, display_title, created_by)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8::uuid)`,
      [id, productionId, parentId, sortKey, targetType, targetId,
       normalizeDisplayTitle(params.displayTitle), params.createdBy],
    );
  } catch (e) {
    // 唯一约束：同一容器下同一目标已有别名
    if (e instanceof Error && "code" in e && (e as { code?: string }).code === "23505")
      return { ok: false, reason: "duplicate" };
    throw e;
  }
  broadcastWikiLibraryChange(productionId, { kind: "created", wikiId: id });
  return { ok: true, alias: (await getWikiAlias(id, productionId))! };
}

/** 移动/重排别名（位置面）。门由调用方跑：源父与目标父的容器写门 + 目标父可枚举。 */
export async function moveWikiAlias(
  id: string, productionId: string,
  patch: { parentId?: string | null; place?: WikiPlacement },
): Promise<{ ok: true; alias: WikiAliasRow } | { ok: false; reason: WikiAliasError | "not_found" }> {
  const existing = await getWikiAlias(id, productionId);
  if (!existing) return { ok: false, reason: "not_found" };
  const nextParentId = patch.parentId !== undefined ? patch.parentId : existing.parentId;
  if (nextParentId !== null && nextParentId !== existing.parentId) {
    const p = await getPool().query(
      `SELECT 1 FROM wiki WHERE id = $1::uuid AND production_id = $2`, [nextParentId, productionId]);
    if (!p.rows[0]) return { ok: false, reason: "parent_not_found" };
  }
  if (await placeInsideTargetSubtree(productionId, nextParentId, existing.targetType, existing.targetId))
    return { ok: false, reason: "inside_target_subtree" };

  // 换父不重算键会留着旧父的键、在新兄弟里位置随机（wiki 侧同款遗留 bug 已在 #357 修）
  const sortKey = patch.place
    ? await placementSortKey(productionId, nextParentId, patch.place, id)
    : nextParentId !== existing.parentId
      ? await tailSortKey(productionId, nextParentId)
      : existing.sortKey;
  try {
    await getPool().query(
      `UPDATE wiki_alias SET parent_id = $3::uuid, sort_key = $4 WHERE id = $1 AND production_id = $2`,
      [id, productionId, nextParentId, sortKey],
    );
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as { code?: string }).code === "23505")
      return { ok: false, reason: "duplicate" };
    throw e;
  }
  broadcastWikiLibraryChange(productionId, { kind: "updated", wikiId: id });
  return { ok: true, alias: (await getWikiAlias(id, productionId))! };
}

/** 空白显示名一律收敛成 null＝跟随目标——"改回自动"和"没设过"必须是同一个状态，
 *  否则库里会留下一个看不见的空串，UI 上表现为无标题。 */
function normalizeDisplayTitle(v: string | null | undefined): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  return t === "" ? null : t;
}

/**
 * 改显示名（#358 ⑤）。只动这个**位置**上的标签：目标标题、目标的任何权限、
 * 别名的可枚举性全都不受影响——所以门与"删这个位置"同一档（容器写门 ∨ 创建者），
 * 不需要目标的 edit 权。传 null/空串＝改回跟随目标。
 */
export async function renameWikiAlias(
  id: string, productionId: string, displayTitle: string | null,
): Promise<WikiAliasRow | null> {
  const { rowCount } = await getPool().query(
    `UPDATE wiki_alias SET display_title = $3 WHERE id = $1 AND production_id = $2`,
    [id, productionId, normalizeDisplayTitle(displayTitle)],
  );
  if (!rowCount) return null;
  broadcastWikiLibraryChange(productionId, { kind: "updated", wikiId: id });
  return getWikiAlias(id, productionId);
}

/** 删别名＝删一个位置，目标一根汗毛不动（别名没有内容、没有历史、没有授权行）。 */
export async function deleteWikiAlias(id: string, productionId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM wiki_alias WHERE id = $1 AND production_id = $2`, [id, productionId]);
  if (!rowCount) return false;
  broadcastWikiLibraryChange(productionId, { kind: "deleted", wikiId: id });
  return true;
}
