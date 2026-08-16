import { type NextRequest, NextResponse } from "next/server";
import { requireUser, toErrorResponse } from "@/lib/agent-gateway/http";
import { getWikiProposalByToolCallId } from "@/lib/wiki-proposal-db";
import { getWiki } from "@/lib/wiki-db";

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

    const parent = proposal.parentWikiId ? await getWiki(proposal.parentWikiId, productionId) : null;
    return NextResponse.json({
      parentTitle: parent?.title ?? null,
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
