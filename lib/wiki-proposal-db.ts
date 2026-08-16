import { getPool } from "./pg";

// wiki_proposal staging 表的薄 CRUD——不是域模型，只是 production.wiki_propose_*
// 工具调用的落地凭证（供前端预览 modal 按 tool_call_id 拉取、审批 modal
// 判断有没有权限）。见 db/add-wiki-proposal.sql + add-wiki-proposal-actions.sql
// 的生命周期注释。

export type WikiProposalStatus =
  | "pending" | "applied"
  | "blocked_no_permission"
  // delete 可能因业务规则（被挂载/系统锚点）拦下——不是权限问题，用独立状态
  // 别误导前端展示"去申请权限"入口。
  | "blocked_business_rule"
  | "rejected";
export type WikiProposalAction = "create" | "update" | "delete" | "move";

export type WikiProposal = {
  id: string;
  productionId: string;
  toolCallId: string;
  proposedBy: string;
  action: WikiProposalAction;
  /** 被操作的既有文档——create 没有，update/delete/move 都要。 */
  targetWikiId: string | null;
  /** create/move 的新父；update/delete 不用。 */
  parentWikiId: string | null;
  title: string | null;
  body: string;
  summary: string;
  hasPermission: boolean;
  permissionKey: string;
  status: WikiProposalStatus;
  /** 这行落地后实际受影响的文档 id——create 是新建的那篇，
   *  update/delete/move 就是 targetWikiId 本身。 */
  createdWikiId: string | null;
  createdAt: string;
};

type WikiProposalRow = {
  id: string; production_id: string; tool_call_id: string; proposed_by: string;
  action: WikiProposalAction; target_wiki_id: string | null;
  parent_wiki_id: string | null; title: string | null; body: string; summary: string;
  has_permission: boolean; permission_key: string; status: WikiProposalStatus;
  created_wiki_id: string | null; created_at: Date;
};

const SELECT_COLUMNS = `id::text AS id, production_id, tool_call_id, proposed_by::text AS proposed_by,
            action, target_wiki_id::text AS target_wiki_id, parent_wiki_id::text AS parent_wiki_id,
            title, body, summary, has_permission, permission_key, status,
            created_wiki_id::text AS created_wiki_id, created_at`;

function rowToProposal(r: WikiProposalRow): WikiProposal {
  return {
    id: r.id, productionId: r.production_id, toolCallId: r.tool_call_id,
    proposedBy: r.proposed_by, action: r.action, targetWikiId: r.target_wiki_id,
    parentWikiId: r.parent_wiki_id, title: r.title, body: r.body, summary: r.summary,
    hasPermission: r.has_permission, permissionKey: r.permission_key, status: r.status,
    createdWikiId: r.created_wiki_id, createdAt: r.created_at.toISOString(),
  };
}

/** upsert：插件 before_tool_call 若因网关重试/重放对同一 toolCallId 再调一次
 *（AI review #249），幂等回填同一行而不是堆出孤儿 pending 行——只在仍是
 *  pending 时刷新内容，已经 resolve 过的行（applied/blocked/rejected）不倒退。 */
export async function insertWikiProposal(params: {
  productionId: string; toolCallId: string; proposedBy: string;
  action: WikiProposalAction; targetWikiId?: string | null;
  parentWikiId?: string | null; title?: string | null; body?: string; summary: string;
  hasPermission: boolean; permissionKey: string;
}): Promise<WikiProposal> {
  const res = await getPool().query<WikiProposalRow>(
    `INSERT INTO wiki_proposal
       (production_id, tool_call_id, proposed_by, action, target_wiki_id, parent_wiki_id,
        title, body, summary, has_permission, permission_key)
     VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, $7, $8, $9, $10, $11)
     ON CONFLICT (production_id, tool_call_id) DO UPDATE SET
       action = EXCLUDED.action, target_wiki_id = EXCLUDED.target_wiki_id,
       parent_wiki_id = EXCLUDED.parent_wiki_id, title = EXCLUDED.title, body = EXCLUDED.body,
       summary = EXCLUDED.summary, has_permission = EXCLUDED.has_permission,
       permission_key = EXCLUDED.permission_key
       WHERE wiki_proposal.status = 'pending'
     RETURNING ${SELECT_COLUMNS}`,
    [
      params.productionId, params.toolCallId, params.proposedBy, params.action,
      params.targetWikiId ?? null, params.parentWikiId ?? null, params.title ?? null,
      params.body ?? "", params.summary, params.hasPermission, params.permissionKey,
    ],
  );
  // WHERE 子句在冲突且已 resolve 时不更新——RETURNING 该情况下为空，
  // 回退查一次已有行（保持函数总有返回值的契约不变）。
  if (res.rows[0]) return rowToProposal(res.rows[0]);
  const existing = await getWikiProposalByToolCallId(params.productionId, params.toolCallId, params.proposedBy);
  if (!existing) throw new Error("wiki_proposal upsert 冲突但查不到已有行（不该发生）");
  return existing;
}

/** 自范围：只认 proposedBy 自己发起的那一行——预览/审批入口都不该看到别人的调用详情。 */
export async function getWikiProposalByToolCallId(
  productionId: string, toolCallId: string, proposedBy: string,
): Promise<WikiProposal | null> {
  const res = await getPool().query<WikiProposalRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM wiki_proposal
     WHERE production_id = $1 AND tool_call_id = $2 AND proposed_by = $3::uuid
     ORDER BY created_at DESC LIMIT 1`,
    [productionId, toolCallId, proposedBy],
  );
  return res.rows[0] ? rowToProposal(res.rows[0]) : null;
}

export async function markWikiProposalApplied(id: string, affectedWikiId: string): Promise<void> {
  await getPool().query(
    `UPDATE wiki_proposal SET status = 'applied', created_wiki_id = $2::uuid, resolved_at = now()
     WHERE id = $1::uuid`,
    [id, affectedWikiId],
  );
}

export async function markWikiProposalBlocked(
  id: string, status: "blocked_no_permission" | "blocked_business_rule" = "blocked_no_permission",
): Promise<void> {
  await getPool().query(
    `UPDATE wiki_proposal SET status = $2, resolved_at = now() WHERE id = $1::uuid`,
    [id, status],
  );
}

export async function markWikiProposalRejected(toolCallId: string): Promise<void> {
  await getPool().query(
    `UPDATE wiki_proposal SET status = 'rejected', resolved_at = now()
     WHERE tool_call_id = $1 AND status = 'pending'`,
    [toolCallId],
  );
}
