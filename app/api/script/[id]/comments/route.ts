import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, listProductionComments, createComment, getCommentById, getProductionName, batchGetFeishuOpenIds } from "@/lib/db";
import type { Mention } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { sendCard, buildScriptCommentMentionCard } from "@/lib/feishu-bot";
import { BASE_PATH } from "@/lib/base-path";
import { getOptedOutUsers } from "@/lib/notification-prefs";

async function guard(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (!hasPermission("script:comment", session.isAdmin, memberRoles, overrides)) {
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

  // Fire-and-forget: notify mentioned users via card
  if (mentions.length > 0) {
    const appId = process.env.FEISHU_APP_ID ?? "";
    const blockPath = `${BASE_PATH}/production/${productionId}/script#block-${blockId}?open_comment=true`;
    const url = `https://applink.feishu.cn/client/web_app/open?appId=${appId}&path=${encodeURIComponent(blockPath)}`;
    const mentionUserIds = [...new Set(mentions.map(m => m.userId))];
    const [optedOut, productionName, userIdToOpenId] = await Promise.all([
      getOptedOutUsers("comment_mention").catch(() => new Set<string>()),
      getProductionName(productionId).catch(() => null),
      batchGetFeishuOpenIds(mentionUserIds).catch(() => new Map<string, string>()),
    ]);
    const card = buildScriptCommentMentionCard(session.name, productionName ?? "制作", text, url);
    for (const m of mentions) {
      if (optedOut.has(m.userId)) continue;
      const openId = userIdToOpenId.get(m.userId);
      if (!openId) continue;
      sendCard(openId, card).catch(e =>
        console.error(`[mention] notify failed for ${m.userId}:`, (e as Error).message)
      );
    }
  }

  return Response.json({ comment }, { status: 201 });
}
