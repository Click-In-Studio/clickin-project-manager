import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, listProductionComments, createComment, getCommentById, getProductionName } from "@/lib/db";
import type { Mention } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { buildScriptCommentMentionCard } from "@/lib/feishu-bot";
import { BASE_PATH } from "@/lib/base-path";
import { notifyUsers } from "@/lib/notify";

async function guard(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  const { permCtx } = access;
  if (!hasPermission("script:comment", permCtx)) {
    return { session, deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  }
  return { session, deny: null };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { deny } = await guard(req, id);
  if (deny) return deny;
  const comments = await listProductionComments(id);
  return Response.json({ comments });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await ctx.params;
  const { session, deny } = await guard(req, productionId);
  if (!session || deny) return deny!;

  const body = (await req.json()) as {
    blockId?: string;
    body?: string;
    parentId?: string;
    mentions?: Mention[];
  };
  const { blockId, parentId = null, mentions = [] } = body;
  const text = body.body?.trim();

  if (!blockId || !text) return Response.json({ error: "参数错误" }, { status: 400 });

  // Validate parentId: must exist, same production, and be a top-level comment (max 2 levels)
  if (parentId) {
    const parent = await getCommentById(parentId);
    if (!parent || parent.productionId !== productionId)
      return Response.json({ error: "父评论不存在" }, { status: 400 });
    if (parent.parentId !== null)
      return Response.json({ error: "不支持超过两层的嵌套回复" }, { status: 400 });
  }

  const comment = await createComment(
    productionId, "block", blockId, parentId,
    session.userId, session.name, text, mentions,
  );

  // Fire-and-forget: notify mentioned users via unified interface (inbox + optional DM).
  if (mentions.length > 0) {
    const blockPath = `${BASE_PATH}/production/${productionId}/script#block-${blockId}?open_comment=true`;
    const mentionUserIds = [...new Set(mentions.map(m => m.userId))];
    const productionName = await getProductionName(productionId).catch(() => null);
    void notifyUsers({
      userIds: mentionUserIds,
      kind: "comment_mention",
      productionId,
      entityType: "comment",
      entityId: comment.id,
      title: `${session.name} 在剧本评论中提到了你`,
      body: text,
      viewHref: blockPath,
      category: "info",
      buildExternalMessage: async (_userId, target) => {
        const actionUrl = target.adapter.buildActionUrl(blockPath);
        const card = buildScriptCommentMentionCard(session.name, productionName ?? "制作", text, actionUrl);
        return {
          text: `${session.name} 在剧本评论中提到了你`,
          title: "评论提及",
          primaryUrl: actionUrl,
          richContent: card,
        };
      },
    }).catch(e => console.error("[mention] notify failed:", e));
  }

  return Response.json({ comment }, { status: 201 });
}
