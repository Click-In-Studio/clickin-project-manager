import type { PoolClient } from "pg";
import { getPool } from "../pg";
import { keyBetween } from "../lex-order";
import { ensureReportTreeAnchors } from "./anchors";
import { getNodeByWikiId, newNodeId } from "./db";
import { canEnterEvent } from "../event-permissions";
import { hasGrant, hasAnyGrant, type GrantActor } from "../grant-check";

// ─── 缺省落点（#420 第二批收官，2026-09-05 拍板）─────────────────────────────
//
// 「业务上下文新建的内容自动放进树哪里」。原则：
//   · 有现成缺省目录的上下文直接用（event 系＝报告树的事件目录链，report 内容
//     嵌套在 report 文档节点下——「上下文嵌套则位置嵌套」）；没有的返回 null，
//     调用方落各自现状（wiki 顶层 / 资产根），**不造新目录结构**——scene/block/
//     cue/独立 task 的实体文件夹布局待拍板，见 #420。
//   · 正文嵌图与正文**同级**（拍板原话）；评论附件维持资产根（拍板：没毛病）。
//   · 解析是尽力而为：调用方对解析结果照跑落位双门，**门不过就回退 null**
//     （=今天的缺省），不 403 打断创建流——落点是便利不是权限面。
//   · ensure 是写事务：只在「实际创建内容」的写路径里调用（过完 create 门之后），
//     渲染路径禁碰。与 parentAnchor 定式的差异（AI review 指正）：这里的 ensure
//     目标由客户端传入（任意 event id），不是固定锚点——所以 ensure 前先过
//     canEnterEvent（「与这个 event 有无干系」），无干系直接 null，不留副作用。
//     event_report / doc-sibling 分支是纯读，无此问题。

// ─── 实体目录（node_entity_dir 指针表）─────────────────────────────────────────
//
// 域目录拍板（2026-09-05）：block → 单个「剧本」目录（不做 per-block，过度设计）；
// cue → 「Cue/<cue 表名>」（per 表，不做 per-cue）；scene → 「场景/<场名>」
// per-scene（拍板：场基本不删；hierarchy 收进域根，几十场平铺会淹树顶）。
// folder title 是实体名副本，
// 解析时**惰性跟随**（每次 get-or-create 顺手对齐，改名写点零改动）。
// production_node_config 行锁做全程互斥（ensureAssetsRootAnchor 同款）。

async function ensureEntityDir(
  client: PoolClient, productionId: string,
  entityType: string, entityId: string,
  title: string, parentId: string | null,
): Promise<string> {
  const ptr = await client.query<{ node_id: string }>(
    `SELECT node_id FROM node_entity_dir
     WHERE production_id = $1 AND entity_type = $2 AND entity_id = $3`,
    [productionId, entityType, entityId],
  );
  if (ptr.rows[0]) {
    await client.query(
      `UPDATE node SET title = $2, updated_at = now()
       WHERE id = $1 AND title IS DISTINCT FROM $2`,
      [ptr.rows[0].node_id, title],
    );
    return ptr.rows[0].node_id;
  }
  const last = await client.query<{ sort_key: string | null }>(
    parentId
      ? `SELECT sort_key FROM node WHERE parent_id = $1 AND sort_key IS NOT NULL ORDER BY sort_key DESC LIMIT 1`
      : `SELECT sort_key FROM node WHERE production_id = $1 AND parent_id IS NULL AND sort_key IS NOT NULL ORDER BY sort_key DESC LIMIT 1`,
    [parentId ?? productionId],
  );
  const id = newNodeId();
  await client.query(
    `INSERT INTO node (id, production_id, kind, parent_id, sort_key, is_public, listable, title)
     VALUES ($1, $2, 'folder', $3, $4, true, true, $5)`,
    [id, productionId, parentId, keyBetween(last.rows[0]?.sort_key ?? null, null), title],
  );
  await client.query(
    `INSERT INTO node_entity_dir (production_id, entity_type, entity_id, node_id)
     VALUES ($1, $2, $3, $4)`,
    [productionId, entityType, entityId, id],
  );
  return id;
}

/** 域目录懒建事务（config 行锁互斥）。dirs 依序建（后项可用前项作父）。 */
async function withEntityDirTxn<T>(
  productionId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO production_node_config (production_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [productionId],
    );
    await client.query(
      `SELECT 1 FROM production_node_config WHERE production_id = $1 FOR UPDATE`,
      [productionId],
    );
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export type LandingContext =
  | { kind: "mount"; mountType: string; mountId: string }
  | { kind: "doc-sibling"; wikiId: string };

/** 解析缺省落点 → 父 node id；null＝无缺省。 */
export async function resolveDefaultLanding(
  actor: GrantActor,
  productionId: string,
  ctx: LandingContext,
): Promise<string | null> {
  if (ctx.kind === "doc-sibling") {
    // 顶层文档（parentId null）的“同级”与「无缺省」编码重合——落回资产根，
    // 树顶不积散件（与树顶上传同一理由）
    const shell = await getNodeByWikiId(ctx.wikiId);
    if (!shell || shell.productionId !== productionId) return null;
    return shell.parentId;
  }

  const pool = getPool();
  // 事件目录懒建统一走这里：写前先判「与该 event 有无干系」
  const ensureEventDirFor = async (eventId: string): Promise<string | null> => {
    if (!actor.isAdmin && !actor.isOwner
        && !await canEnterEvent(actor, productionId, eventId)) return null;
    return ensureReportTreeAnchors(productionId, eventId);
  };
  switch (ctx.mountType) {
    case "event": {
      const { rows } = await pool.query(
        `SELECT 1 FROM production_event WHERE id = $1 AND production_id = $2`,
        [ctx.mountId, productionId],
      );
      return rows[0] ? ensureEventDirFor(ctx.mountId) : null;
    }
    case "event_schedule": {
      const { rows } = await pool.query<{ event_id: string }>(
        `SELECT esi.event_id FROM event_schedule_item esi
         JOIN production_event pe ON pe.id = esi.event_id
         WHERE esi.id = $1 AND pe.production_id = $2`,
        [ctx.mountId, productionId],
      );
      return rows[0] ? ensureEventDirFor(rows[0].event_id) : null;
    }
    case "event_report": {
      // report 内容嵌套在 report 文档节点下（events/<event>/<report>/…）
      const { rows } = await pool.query<{ node_id: string }>(
        `SELECT er.node_id FROM event_report er
         JOIN production_event pe ON pe.id = er.event_id
         WHERE er.id = $1 AND pe.production_id = $2`,
        [ctx.mountId, productionId],
      );
      return rows[0]?.node_id ?? null;
    }
    case "task": {
      // 挂了 event 的 task 归其事件目录；独立 task 无缺省（布局待拍板）
      const { rows } = await pool.query<{ event_id: string | null }>(
        `SELECT event_id FROM task WHERE id = $1 AND production_id = $2`,
        [ctx.mountId, productionId],
      );
      return rows[0]?.event_id ? ensureEventDirFor(rows[0].event_id) : null;
    }
    case "block": {
      // 拍板：单个「剧本」目录收全部剧本上下文内容，不做 per-block（过度设计）。
      // 干系＝剧本读者（与挂载让渡的 script 通道同锚）
      if (!actor.isAdmin && !actor.isOwner
          && !await hasGrant(actor.userId, productionId, "script", "*", "blocks", "view")) return null;
      const { rows } = await pool.query(
        `SELECT 1 FROM script WHERE block_id = $1 AND production_id = $2 LIMIT 1`,
        [ctx.mountId, productionId],
      );
      if (!rows[0]) return null;
      return withEntityDirTxn(productionId, c =>
        ensureEntityDir(c, productionId, "script", "*", "剧本", null));
    }
    case "cue": {
      // 拍板：「Cue/<cue 表名>」per 表目录，不做 per-cue。mount_id 是稳定 cue_id
      const { rows } = await pool.query<{ cue_list_id: string; name: string }>(
        `SELECT c.cue_list_id, cl.name FROM cue c
         JOIN cue_list cl ON cl.id = c.cue_list_id
         WHERE c.cue_id = $1 AND cl.production_id = $2 LIMIT 1`,
        [ctx.mountId, productionId],
      );
      if (!rows[0]) return null;
      if (!actor.isAdmin && !actor.isOwner
          && !await hasGrant(actor.userId, productionId, "cue_list", rows[0].cue_list_id, "cues", "view")) return null;
      const { cue_list_id, name } = rows[0];
      return withEntityDirTxn(productionId, async c => {
        const root = await ensureEntityDir(c, productionId, "cue_root", "*", "Cue", null);
        return ensureEntityDir(c, productionId, "cue_list", cue_list_id, name, root);
      });
    }
    case "scene": {
      // 拍板：「场景/<场名>」per-scene。场名取 head 版（scene 表裸 id，名字在
      // scene_version；场次号是 marker 运行时派生不落库，标题只用名字）。
      // 干系＝scene meta@view（与让渡通道同锚）
      if (!actor.isAdmin && !actor.isOwner
          && !await hasAnyGrant(actor.userId, productionId, "scene", ["meta"], "view")) return null;
      const { rows } = await pool.query<{ name: string }>(
        `SELECT sv.name FROM scene s
         JOIN production p ON p.id = s.production_id
         JOIN scene_version sv ON sv.scene_id = s.id AND sv.version_id = p.active_version_id
         WHERE s.id = $1 AND s.production_id = $2`,
        [ctx.mountId, productionId],
      );
      if (!rows[0]) return null;
      const title = rows[0].name.trim() || "（未命名场景）";
      return withEntityDirTxn(productionId, async c => {
        const root = await ensureEntityDir(c, productionId, "scene_root", "*", "场景", null);
        return ensureEntityDir(c, productionId, "scene", ctx.mountId, title, root);
      });
    }
    default:
      // comment：拍板落资产根，无缺省
      return null;
  }
}

/** 请求体里的 landing 字段解析（两条创建路由共用，非法形状一律当 undefined）。 */
export function readLandingContext(raw: unknown): LandingContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  if (v.kind === "doc-sibling" && typeof v.wikiId === "string" && v.wikiId) {
    return { kind: "doc-sibling", wikiId: v.wikiId };
  }
  if (v.kind === "mount" && typeof v.mountType === "string" && v.mountType
      && typeof v.mountId === "string" && v.mountId) {
    return { kind: "mount", mountType: v.mountType, mountId: v.mountId };
  }
  return undefined;
}
