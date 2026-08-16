import { type NextRequest, NextResponse } from "next/server";
import { requireUser, toErrorResponse } from "@/lib/agent-gateway/http";
import { getWikiProposalByToolCallId } from "@/lib/wiki-proposal-db";
import { getWiki } from "@/lib/wiki-db";
import { resolveProductionActor } from "@/lib/mcp/production-tools";
import { canViewWiki } from "@/lib/wiki-perm";

// 供 WikiProposalPreviewModal 按 toolCallId 拉取完整提议内容（确认卡片
// description 硬上限 512 字符装不下）。自范围：只认自己发起的那一行——
// getWikiProposalByToolCallId 内部按 proposedBy 过滤，不是本路由自己做的。
export async function GET(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;

  const productionId = req.nextUrl.searchParams.get("productionId");
  const toolCallId = req.nextUrl.searchParams.get("toolCallId");
  if (!productionId || !toolCallId) {
    return NextResponse.json({ error: "缺少 productionId/toolCallId" }, { status: 400 });
  }

  try {
    const proposal = await getWikiProposalByToolCallId(productionId, toolCallId, auth.userId);
    if (!proposal) return NextResponse.json({ error: "未找到该提议" }, { status: 404 });

    // 父文档标题按当前可见性门再查一遍——不能假设 propose 时刻的可见性
    // 到预览时刻还成立（权限可能被收回），也不能假设 parentId 一定是调用者
    // 真正看得到的文档（模型可能填了个它凭空编的/别处拿到的 id）。
    let parentTitle: string | null = null;
    if (proposal.parentWikiId) {
      const resolved = await resolveProductionActor(auth.userId, productionId);
      if (resolved && await canViewWiki(resolved.actor, productionId, proposal.parentWikiId)) {
        const parent = await getWiki(proposal.parentWikiId, productionId);
        parentTitle = parent?.title ?? null;
      }
    }
    return NextResponse.json({
      parentTitle,
      title: proposal.title,
      body: proposal.body,
      summary: proposal.summary,
      hasPermission: proposal.hasPermission,
      permissionKey: proposal.permissionKey,
      status: proposal.status,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
