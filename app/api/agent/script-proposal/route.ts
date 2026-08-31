import { type NextRequest, NextResponse } from "next/server";
import { requireUser, requireOwnership, toErrorResponse } from "@/lib/agent-chat/http";
import { getPool } from "@/lib/pg";
import { parseSessionIdentity } from "@/lib/agent-tools/session-identity";

// 供确认卡「查看详情」modal 按 toolCallId 拉取剧本写提议的全量预览（卡片
// description 硬上限 512 字符装不下逐块 diff 与方言全文）。
//
// 与 wiki-proposal 路由的差别：剧本提议没有预持久化行——参数就在 agent_approval.args
// 里，预览用 previewScriptProposal 现算（与确认卡 preflight、确认后执行是同一份
// 规划与权限判定，三处永远同源）。
//
// 所有权：审批行归属触发它的会话，只有会话主人能看（requireOwnership，同
// /api/agent/approval）；制作维度再与会话身份对一遍，防拿着自己别的制作的
// toolCallId 串上下文。

const SCRIPT_TOOLS: Record<string, "rewrite" | "edit_blocks"> = {
  "clickin__production-script_propose_rewrite": "rewrite",
  "clickin__production-script_propose_edit_blocks": "edit_blocks",
};

export async function GET(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  const productionId = req.nextUrl.searchParams.get("productionId");
  const toolCallId = req.nextUrl.searchParams.get("toolCallId");
  if (!productionId || !toolCallId) {
    return NextResponse.json({ error: "缺少 productionId/toolCallId" }, { status: 400 });
  }

  try {
    const r = await getPool().query<{ session_id: string; tool: string; args: Record<string, unknown> }>(
      `SELECT session_id, tool, args FROM agent_approval
       WHERE tool_call_id = $1 AND tool = ANY($2::text[])
       ORDER BY expires_at DESC LIMIT 1`,
      [toolCallId, Object.keys(SCRIPT_TOOLS)],
    );
    const row = r.rows[0];
    if (!row) return NextResponse.json({ error: "未找到该提议" }, { status: 404 });
    const denied = requireOwnership(row.session_id, auth.userId);
    if (denied) return denied;
    if (parseSessionIdentity(row.session_id)?.productionId !== productionId) {
      return NextResponse.json({ error: "未找到该提议" }, { status: 404 });
    }

    const kind = SCRIPT_TOOLS[row.tool];
    const bare = row.tool.replace(/^clickin__/, "");
    const { previewScriptProposal } = await import("@/lib/agent-tools/script-write-tools");
    // 与 preflight/执行同一份规划：状态在卡片弹出后可能已变（别人编辑了剧本），
    // 现算的预览就是"此刻批准会发生什么"；规划错误不代表 404，原样给 modal 展示
    const preview = await previewScriptProposal(auth.userId, productionId, bare, row.args ?? {});

    const a = row.args ?? {};
    return NextResponse.json({
      kind,
      summary: typeof a.summary === "string" ? a.summary : "",
      sectionId: typeof a.sectionId === "string" ? a.sectionId : null,
      dialect: typeof a.dialect === "string" ? a.dialect : null,
      updates: Array.isArray(a.updates) ? a.updates : [],
      inserts: Array.isArray(a.inserts) ? a.inserts : [],
      deletes: Array.isArray(a.deletes) ? a.deletes : [],
      hasPermission: preview.hasPermission,
      notes: preview.notes,
      error: preview.error ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
