import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, listProductionComments, createComment, getCommentById, getProductionName, batchGetFeishuOpenIds } from "@/lib/db";
import type { Mention } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { sendBotDm } from "@/lib/feishu-bot";
import { getOptedOutUsers } from "@/lib/notification-prefs";

async function guard(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (!hasPermission("cue:read", session.isAdmin, memberRoles, overrides))
    return { session, deny: Response.json({ error: "无权访问" }, { status: 403 }), isArchived };
  return { session, deny: null, isArchived };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { deny } = await guard(req, id);
  if (deny) return deny;
  const all = await listProductionComments(id);
  const comments = all.filter(c => c.contextType === "cue");
  return Response.json({ comments });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await ctx.params;
  const { session, deny, isArchived } = await guard(req, productionId);
  if (!session || deny) return deny!;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const body = (await req.json()) as {
    cueId?: string;
    body?: string;
    parentId?: string;
    mentions?: Mention[];
  };
  const { cueId, parentId = null, mentions = [] } = body;
  const text = body.body?.trim();

  if (!cueId || !text) return Response.json({ error: "参数错误" }, { status: 400 });

  if (parentId) {
    const parent = await getCommentById(parentId);
    if (!parent || parent.productionId !== productionId)
      return Response.json({ error: "父评论不存在" }, { status: 400 });
    if (parent.parentId !== null)
      return Response.json({ error: "不支持超过两层的嵌套回复" }, { status: 400 });
  }

  const comment = await createComment(
    productionId, "cue", cueId, parentId,
    session.userId, session.name, text, mentions,
  );

  if (mentions.length > 0) {
    const mentionUserIds = [...new Set(mentions.map(m => m.userId))];
    Promise.all([
      getProductionName(productionId).catch(() => null),
      getOptedOutUsers("comment_mention").catch(() => new Set<string>()),
      batchGetFeishuOpenIds(mentionUserIds).catch(() => new Map<string, string>()),
    ]).then(([productionName, optedOut, userIdToOpenId]) => {
      const prefix = productionName ? `《${productionName}》` : "制作";
      const notifyText = `${session.name} 在${prefix}的 Cue 评论中提到了你：\n${text}`;
      for (const m of mentions) {
        if (optedOut.has(m.userId)) continue;
        const openId = userIdToOpenId.get(m.userId);
        if (!openId) continue;
        sendBotDm(openId, notifyText).catch(e =>
          console.error(`[mention] notify failed for ${m.userId}:`, (e as Error).message)
        );
      }
    }).catch(() => {});
  }

  return Response.json({ comment }, { status: 201 });
}
