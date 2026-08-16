import { getPool } from "./pg";

// wiki_proposal staging 表的薄 CRUD——不是域模型，只是 production.wiki_propose
// 工具调用的落地凭证（供前端预览 modal 按 tool_call_id 拉取、审批 modal
// 判断有没有权限）。见 db/add-wiki-proposal.sql 的生命周期注释。

export type WikiProposalStatus = "pending" | "applied" | "blocked_no_permission" | "rejected";

export type WikiProposal = {
  id: string;
  productionId: string;
  toolCallId: string;
  proposedBy: string;
  parentWikiId: string | null;
  title: string;
  body: string;
  summary: string;
  hasPermission: boolean;
  permissionKey: string;
  status: WikiProposalStatus;
  createdWikiId: string | null;
  createdAt: string;
};

type WikiProposalRow = {
  id: string; production_id: string; tool_call_id: string; proposed_by: string;
  parent_wiki_id: string | null; title: string; body: string; summary: string;
  has_permission: boolean; permission_key: string; status: WikiProposalStatus;
  created_wiki_id: string | null; created_at: Date;
};

function rowToProposal(r: WikiProposalRow): WikiProposal {
  return {
    id: r.id, productionId: r.production_id, toolCallId: r.tool_call_id,
    proposedBy: r.proposed_by, parentWikiId: r.parent_wiki_id, title: r.title,
    body: r.body, summary: r.summary, hasPermission: r.has_permission,
    permissionKey: r.permission_key, status: r.status, createdWikiId: r.created_wiki_id,
    createdAt: r.created_at.toISOString(),
  };
}

/** upsert：插件 before_tool_call 若因网关重试/重放对同一 toolCallId 再调一次
 *（AI review #249），幂等回填同一行而不是堆出孤儿 pending 行——只在仍是
 *  pending 时刷新内容，已经 resolve 过的行（applied/blocked/rejected）不倒退。 */
export async function insertWikiProposal(params: {
  productionId: string; toolCallId: string; proposedBy: string;
  parentWikiId?: string | null; title: string; body: string; summary: string;
  hasPermission: boolean; permissionKey: string;
}): Promise<WikiProposal> {
  const res = await getPool().query<WikiProposalRow>(
    `INSERT INTO wiki_proposal
       (production_id, tool_call_id, proposed_by, parent_wiki_id, title, body, summary,
        has_permission, permission_key)
     VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9)
     ON CONFLICT (production_id, tool_call_id) DO UPDATE SET
       parent_wiki_id = EXCLUDED.parent_wiki_id, title = EXCLUDED.title, body = EXCLUDED.body,
       summary = EXCLUDED.summary, has_permission = EXCLUDED.has_permission,
       permission_key = EXCLUDED.permission_key
       WHERE wiki_proposal.status = 'pending'
     RETURNING id::text AS id, production_id, tool_call_id, proposed_by::text AS proposed_by,
               parent_wiki_id::text AS parent_wiki_id, title, body, summary,
               has_permission, permission_key, status, created_wiki_id::text AS created_wiki_id,
               created_at`,
    [
      params.productionId, params.toolCallId, params.proposedBy,
      params.parentWikiId ?? null, params.title, params.body, params.summary,
      params.hasPermission, params.permissionKey,
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
    `SELECT id::text AS id, production_id, tool_call_id, proposed_by::text AS proposed_by,
            parent_wiki_id::text AS parent_wiki_id, title, body, summary,
            has_permission, permission_key, status, created_wiki_id::text AS created_wiki_id,
            created_at
     FROM wiki_proposal
     WHERE production_id = $1 AND tool_call_id = $2 AND proposed_by = $3::uuid
     ORDER BY created_at DESC LIMIT 1`,
    [productionId, toolCallId, proposedBy],
  );
  return res.rows[0] ? rowToProposal(res.rows[0]) : null;
}

export async function markWikiProposalApplied(id: string, createdWikiId: string): Promise<void> {
  await getPool().query(
    `UPDATE wiki_proposal SET status = 'applied', created_wiki_id = $2::uuid, resolved_at = now()
     WHERE id = $1::uuid`,
    [id, createdWikiId],
  );
}

export async function markWikiProposalBlocked(id: string): Promise<void> {
  await getPool().query(
    `UPDATE wiki_proposal SET status = 'blocked_no_permission', resolved_at = now() WHERE id = $1::uuid`,
    [id],
  );
}

export async function markWikiProposalRejected(toolCallId: string): Promise<void> {
  await getPool().query(
    `UPDATE wiki_proposal SET status = 'rejected', resolved_at = now()
     WHERE tool_call_id = $1 AND status = 'pending'`,
    [toolCallId],
  );
}
