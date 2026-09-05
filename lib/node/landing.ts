import { getPool } from "../pg";
import { ensureReportTreeAnchors } from "./anchors";
import { getNodeByWikiId } from "./db";

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
//     渲染路径禁碰（write-before-authz，与 parentAnchor 定式同款）。

export type LandingContext =
  | { kind: "mount"; mountType: string; mountId: string }
  | { kind: "doc-sibling"; wikiId: string };

/** 解析缺省落点 → 父 node id；null＝无缺省。 */
export async function resolveDefaultLanding(
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
  switch (ctx.mountType) {
    case "event":
      return ensureReportTreeAnchors(productionId, ctx.mountId);
    case "event_schedule": {
      const { rows } = await pool.query<{ event_id: string }>(
        `SELECT esi.event_id FROM event_schedule_item esi
         JOIN production_event pe ON pe.id = esi.event_id
         WHERE esi.id = $1 AND pe.production_id = $2`,
        [ctx.mountId, productionId],
      );
      return rows[0] ? ensureReportTreeAnchors(productionId, rows[0].event_id) : null;
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
      return rows[0]?.event_id ? ensureReportTreeAnchors(productionId, rows[0].event_id) : null;
    }
    default:
      // scene / block / cue / comment：暂无缺省（scene 等的实体文件夹布局待拍板；
      // comment 拍板落资产根）
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
