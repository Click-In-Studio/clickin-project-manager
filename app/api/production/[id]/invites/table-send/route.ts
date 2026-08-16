import { type NextRequest } from "next/server";
import { requireGrantGate } from "@/lib/api-guard";
import { createInvite, createClaimInvite } from "@/lib/invite-db";
import { getProductionName } from "@/lib/db";
import { notifyUsers } from "@/lib/notify";
import { sendBotDm } from "@/lib/platform/feishu/feishu-bot";
import { sendEmail } from "@/lib/platform/email/email-send";
import { SERVER_URL } from "@/lib/server-url";

type Ctx = { params: Promise<{ id: string }> };

// 邀请表格执行（#156）：按 parse-table 的行分类发送——
//   registered  → 定向邀请（target_user_id）+ 站内通知（默认外部通道跟随偏好）
//   feishu_only → 定向邀请（feishu_open_id）+ 飞书 bot DM；有邮箱再发邮件
//   email_only  → 定向邀请（email）+ 邀请邮件
//   none        → 不发；makeClaimLink=true 时生成批量认领链接（按名字认领+逐行预配）

type InRow = {
  name: string;
  roles?: string[];
  deptIds?: string[];
  email?: string | null;
  feishuOpenId?: string | null;
  category?: string;
  userId?: string | null;
  alreadyMember?: boolean;
};

function inviteUrl(token: string): string {
  return `${SERVER_URL}/invite/${token}`;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny, session } = await requireGrantGate(req, id, [["member", "*", "create"]], { blockArchived: true });
  if (deny) return deny;

  const body = (await req.json()) as { rows?: unknown; makeClaimLink?: boolean };
  if (!Array.isArray(body.rows) || body.rows.length === 0 || body.rows.length > 200) {
    return Response.json({ error: "rows 须为 1-200 行" }, { status: 400 });
  }
  const rows = body.rows as InRow[];
  const name = (await getProductionName(id)) ?? "项目";
  const me = session!.userId;

  const result = {
    notified: 0, feishuSent: 0, emailSent: 0,
    skippedMembers: [] as string[],
    noChannel: [] as string[],
    failures: [] as string[],
    claimUrl: null as string | null,
    claimCount: 0,
  };
  const noneRows: InRow[] = [];

  for (const r of rows) {
    if (!r.name?.trim()) continue;
    const presetRoles = Array.isArray(r.roles) ? r.roles : [];
    const presetDeptIds = Array.isArray(r.deptIds) ? r.deptIds : [];
    try {
      if (r.alreadyMember) {
        result.skippedMembers.push(r.name);
        continue;
      }
      if (r.userId) {
        // 已注册：定向 + 站内通知（外部通道按用户偏好）
        const { token } = await createInvite({
          productionId: id, targetUserId: r.userId, createdBy: me,
          expiresInDays: 14, presetRoles, presetDeptIds,
        });
        const url = inviteUrl(token);
        await notifyUsers({
          userIds: [r.userId],
          kind: "member_invite",
          productionId: null,
          entityType: "production_invite",
          entityId: token,
          title: `邀请你加入「${name}」`,
          body: "点击接受邀请后自动加入项目。",
          viewHref: `/invite/${token}`,
          category: "action",
          actionRequired: true,
          buildExternalMessage: async () => ({
            type: "text",
            text: `你被邀请加入剧组项目「${name}」，打开链接接受：${url}`,
          }),
        });
        result.notified++;
      } else if (r.feishuOpenId) {
        const { token } = await createInvite({
          productionId: id, feishuOpenId: r.feishuOpenId, createdBy: me,
          expiresInDays: 14, presetRoles, presetDeptIds,
        });
        const url = inviteUrl(token);
        await sendBotDm(r.feishuOpenId, `你被邀请加入剧组项目「${name}」，打开链接登录后自动加入：${url}`);
        result.feishuSent++;
        if (r.email) {
          await sendEmail({
            to: r.email,
            subject: `邀请你加入「${name}」`,
            html: `<p>你被邀请加入剧组项目「<b>${name}</b>」。</p><p><a href="${url}">点击接受邀请</a>（登录或注册后自动加入）。</p>`,
            text: `你被邀请加入剧组项目「${name}」，打开链接接受：${url}`,
          }).catch(() => {});
          result.emailSent++;
        }
      } else if (r.email) {
        const { token } = await createInvite({
          productionId: id, email: r.email, createdBy: me,
          expiresInDays: 14, presetRoles, presetDeptIds,
        });
        const url = inviteUrl(token);
        await sendEmail({
          to: r.email,
          subject: `邀请你加入「${name}」`,
          html: `<p>你被邀请加入剧组项目「<b>${name}</b>」。</p><p><a href="${url}">点击接受邀请</a>（登录或注册后自动加入）。</p>`,
          text: `你被邀请加入剧组项目「${name}」，打开链接接受：${url}`,
        });
        result.emailSent++;
      } else {
        result.noChannel.push(r.name);
        noneRows.push(r);
      }
    } catch (e) {
      result.failures.push(`${r.name}: ${e instanceof Error ? e.message : "失败"}`);
    }
  }

  if (body.makeClaimLink && noneRows.length > 0) {
    const { token } = await createClaimInvite({
      productionId: id, createdBy: me,
      entries: noneRows.map(r => ({
        name: r.name.trim(),
        presetRoles: Array.isArray(r.roles) ? r.roles : [],
        presetDeptIds: Array.isArray(r.deptIds) ? r.deptIds : [],
      })),
      expiresInDays: 30,
    });
    result.claimUrl = inviteUrl(token);
    result.claimCount = noneRows.length;
  }

  return Response.json({ ok: true, ...result });
}
