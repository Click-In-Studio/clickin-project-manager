import { getPool } from "@/lib/pg";

export type WikiPatchPreview = {
  baseHash: string;
  patchDiff: string;
  patchCounts: number[];
  hasPermission: boolean;
  proposalId: string;
};

/** 复用持久化审批快照；进程恢复时不能对新正文重新规划一张旧确认卡。 */
export async function getWikiPatchApproval(userId: string, productionId: string, toolCallId: string) {
  const result = await getPool().query<{ preview: WikiPatchPreview; status: string; reason: string | null }>(
    `SELECT a.preview, a.status, a.reason FROM agent_approval a
     JOIN agent_session s ON s.id = a.session_id
     WHERE s.user_id = $1::uuid AND s.production_id = $2 AND a.tool_call_id = $3
       AND a.tool = 'clickin__production-wiki_propose_patch'
     ORDER BY a.created_at DESC LIMIT 1`,
    [userId, productionId, toolCallId],
  );
  return result.rows[0] ?? null;
}
