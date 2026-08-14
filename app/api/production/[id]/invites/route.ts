import { type NextRequest } from "next/server";
import { requireGrantGate } from "@/lib/api-guard";
import { createInvite, listInvites, revokeInvite } from "@/lib/invite-db";
import { getProductionName } from "@/lib/db";
import { sendEmail } from "@/lib/platform/email/email-send";
import { SERVER_URL } from "@/lib/server-url";

type Ctx = { params: Promise<{ id: string }> };

// 项目邀请（#156）：开放链接 + 定向邮件邀请。门=member/*/*@create（邀请即人事纳新）。

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function inviteUrl(token: string): string {
  return `${SERVER_URL}/invite/${token}`;
}

async function sendInviteEmail(to: string, productionName: string, token: string) {
  const url = inviteUrl(token);
  await sendEmail({
    to,
    subject: `邀请你加入「${productionName}」`,
    html: `<p>你被邀请加入剧组项目「<b>${productionName}</b>」。</p>
<p><a href="${url}">点击此处接受邀请</a>（登录或注册后自动加入）。</p>
<p style="color:#888;font-size:12px">若非本人预期，请忽略此邮件。链接：${url}</p>`,
    text: `你被邀请加入剧组项目「${productionName}」。打开链接接受邀请（登录或注册后自动加入）：${url}`,
  });
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGrantGate(req, id, [["member", "*", "create"]]);
  if (deny) return deny;
  return Response.json({ invites: await listInvites(id) });
}

/** POST — 创建邀请。Body:
 *  { kind: "link", expiresInDays?, maxUses?, presetRoles?, presetDeptIds? }
 *  { kind: "email", emails: string[], presetRoles?, presetDeptIds? }（逐个定向+发信） */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny, session } = await requireGrantGate(req, id, [["member", "*", "create"]], { blockArchived: true });
  if (deny) return deny;

  const body = (await req.json()) as {
    kind?: string;
    emails?: unknown;
    expiresInDays?: number | null;
    maxUses?: number | null;
    presetRoles?: string[];
    presetDeptIds?: string[];
  };
  const presetRoles = Array.isArray(body.presetRoles) ? body.presetRoles.filter(r => typeof r === "string") : [];
  const presetDeptIds = Array.isArray(body.presetDeptIds) ? body.presetDeptIds.filter(d => typeof d === "string") : [];

  if (body.kind === "link") {
    const expiresInDays = typeof body.expiresInDays === "number" && body.expiresInDays > 0
      ? Math.min(body.expiresInDays, 365) : 7;
    const maxUses = typeof body.maxUses === "number" && body.maxUses > 0
      ? Math.min(body.maxUses, 500) : null;
    const { token } = await createInvite({
      productionId: id, createdBy: session!.userId,
      expiresInDays, maxUses, presetRoles, presetDeptIds,
    });
    return Response.json({ ok: true, token, url: inviteUrl(token) }, { status: 201 });
  }

  if (body.kind === "email") {
    if (!Array.isArray(body.emails) || body.emails.length === 0) {
      return Response.json({ error: "emails 必填" }, { status: 400 });
    }
    const emails = [...new Set((body.emails as unknown[])
      .filter((e): e is string => typeof e === "string")
      .map(e => e.trim().toLowerCase())
      .filter(Boolean))];
    if (emails.length === 0 || emails.length > 100) {
      return Response.json({ error: "邮箱数量须为 1-100" }, { status: 400 });
    }
    const invalid = emails.filter(e => !EMAIL_RE.test(e));
    if (invalid.length) {
      return Response.json({ error: `邮箱格式非法：${invalid.slice(0, 3).join(", ")}${invalid.length > 3 ? " …" : ""}` }, { status: 400 });
    }

    const name = (await getProductionName(id)) ?? "项目";
    const results: { email: string; ok: boolean; error?: string }[] = [];
    for (const email of emails) {
      try {
        const { token } = await createInvite({
          productionId: id, email, createdBy: session!.userId,
          expiresInDays: 14, presetRoles, presetDeptIds,
        });
        await sendInviteEmail(email, name, token);
        results.push({ email, ok: true });
      } catch (e) {
        results.push({ email, ok: false, error: e instanceof Error ? e.message : "发送失败" });
      }
    }
    const sent = results.filter(r => r.ok).length;
    return Response.json({ ok: sent > 0, sent, failed: results.length - sent, results }, { status: 201 });
  }

  return Response.json({ error: "kind 须为 link 或 email" }, { status: 400 });
}

/** DELETE — 撤销邀请。Body: { token } */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGrantGate(req, id, [["member", "*", "create"]]);
  if (deny) return deny;

  const { token } = (await req.json()) as { token?: string };
  if (!token) return Response.json({ error: "缺少 token" }, { status: 400 });
  const ok = await revokeInvite(id, token);
  if (!ok) return Response.json({ error: "邀请不存在或已撤销" }, { status: 404 });
  return Response.json({ ok: true });
}
