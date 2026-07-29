import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { signBindingToken } from "@/lib/auth-email";
import { sendEmail } from "@/lib/email";

function requestBaseUrl(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json() as { email?: string };
  const email = body.email?.trim().toLowerCase();
  if (!email) return Response.json({ error: "missing email" }, { status: 400 });

  const token = signBindingToken(session.userId, email);
  const baseUrl = requestBaseUrl(req);
  const link = `${baseUrl}/api/account/bind/email/callback?token=${encodeURIComponent(token)}`;

  await sendEmail({
    to: email,
    subject: "绑定邮箱到 Click-In 账号",
    html: `
      <p>点击下方链接将此邮箱绑定到你的 Click-In 账号：</p>
      <p><a href="${link}" style="font-size:16px;font-weight:bold">点击绑定</a></p>
      <p style="color:#888;font-size:12px">链接 15 分钟内有效，请勿转发。</p>
    `,
    text: `点击以下链接绑定邮箱（15 分钟内有效）：\n\n${link}`,
  });

  return Response.json({ sent: true });
}
