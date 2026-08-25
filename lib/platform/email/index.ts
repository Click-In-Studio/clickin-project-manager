import { randomInt } from "node:crypto";
import { signMagicToken, verifyMagicToken } from "./email-tokens";
import { sendEmail } from "./email-send";
import { upsertEmailUser, getUserProfile, createEmailOtp } from "../../db";
import { requireRegistrationJustification, identityExists, AuthIntentMismatchError } from "../../registration-gate";
import { buildNotificationEmail } from "./email-templates";
import type {
  PersonalChannel,
  PersonalCapabilities,
  InboundGateway,
  GatewayResult,
  PlatformIdentity,
  PlatformMessage,
  PlatformUserInfo,
  LoginResult,
} from "../types";

const MAGIC_LINK_PATH = "/api/auth/email/callback";
const OTP_TTL_MS = 15 * 60 * 1000;

class EmailPlatform implements PersonalChannel, InboundGateway {
  readonly platformId = "email" as const;

  readonly capabilities: PersonalCapabilities = {
    canLogin: true,
    canSendDirect: true,
    supportsInteractiveMessages: false,
    supportsRichMessages: true,
  };

  // ── Auth ──────────────────────────────────────────────────────────────────

  generateAuthUrl(_state: string, _redirectUri: string): string {
    throw new Error("email: OAuth not supported — use initiateLogin");
  }

  async handleAuthCallback(token: string): Promise<PlatformIdentity> {
    const data = verifyMagicToken(token);
    if (!data) throw new Error("email: invalid or expired magic link token");
    return { platformUserId: data.email, name: data.email };
  }

  async initiateLogin(
    params: Record<string, string>,
    context?: { baseUrl: string },
  ): Promise<void> {
    const email = params.email?.trim().toLowerCase();
    if (!email) throw new Error("email: missing email param");

    // 意图不参与判定（谁该建号由 identity 表说了算），只用来把报错说准：
    // 在登录页输了个没注册过的邮箱，该明说「未注册」，而不是默默建个号——
    // 那正是「登录即注册」时代的老毛病。未声明意图的老客户端行为不变。
    const authIntent = params.authIntent === "login" || params.authIntent === "register"
      ? params.authIntent
      : undefined;
    if (authIntent) {
      const exists = await identityExists("email", email);
      if (authIntent === "login" && !exists) {
        throw new AuthIntentMismatchError("该邮箱尚未注册，请先注册");
      }
      if (authIntent === "register" && exists) {
        throw new AuthIntentMismatchError("该邮箱已注册，请直接登录");
      }
      // 注册必须自报姓名——不再回落成邮箱地址（那会让成员列表里显示一串邮箱）
      if (authIntent === "register" && !params.name?.trim()) {
        throw new AuthIntentMismatchError("请填写姓名");
      }
    }
    const name = params.name?.trim() || email;

    // 注册邀请制（REGISTRATION_INVITE_ONLY）：这里是新账号的唯一写点——发验证码
    // 即建号，邮箱验证之前就落 app_user 行。开关开启时，新邮箱需正当性
    // （邀请码 / 指定邮箱登记 / 定向邀请 / 邀请链接透传），全落空抛
    // RegistrationDeniedError（路由转 403）。老用户登录不受影响。
    const justification = await requireRegistrationJustification({
      platformId: "email",
      platformUserId: email,
      inviteToken: params.inviteToken,
      registrationCode: params.registrationCode,
    });
    const { userId } = await upsertEmailUser(
      email,
      name,
      justification?.type === "code" ? justification.code : undefined,
    );

    // Generate magic link (stateless JWT)
    const token = signMagicToken(userId, email);
    const baseUrl = context?.baseUrl ?? "";
    const magicLink = `${baseUrl}${MAGIC_LINK_PATH}?token=${encodeURIComponent(token)}`;

    // Generate OTP (6-digit, stored in DB)
    const otp = randomInt(100000, 1000000).toString();
    await createEmailOtp(userId, email, otp, OTP_TTL_MS);

    await sendEmail({
      to: email,
      subject: "登录「后台」",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="margin:0 0 16px;font-size:18px;color:#182a2a">登录「后台」</h2>
          <p style="margin:0 0 20px;color:#667676;font-size:14px">两种方式均可完成登录，15 分钟内有效：</p>

          <div style="margin-bottom:20px">
            <p style="margin:0 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#a55c32">方式一：点击链接</p>
            <a href="${magicLink}" style="display:inline-block;padding:10px 20px;font-size:14px;font-weight:700;background:#182a2a;color:#fff;text-decoration:none;border-radius:8px">点击此处登录</a>
            <p style="margin:6px 0 0;font-size:11px;color:#999">在收到邮件的设备上点击</p>
          </div>

          <div style="padding:16px;background:#f3f4f3;border-radius:10px">
            <p style="margin:0 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#a55c32">方式二：输入验证码</p>
            <p style="margin:0 0 4px;font-size:32px;font-weight:800;letter-spacing:.2em;color:#182a2a;font-family:monospace">${otp}</p>
            <p style="margin:0;font-size:11px;color:#999">在登录页面输入此 6 位数字</p>
          </div>

          <p style="margin:20px 0 0;font-size:11px;color:#bbb">请勿将验证码分享给他人。</p>
        </div>
      `,
      text: `登录「后台」\n\n方式一：点击链接（在收到邮件的设备上使用）\n${magicLink}\n\n方式二：在登录页输入 6 位验证码\n${otp}\n\n链接和验证码均在 15 分钟内有效，请勿转发。`,
    });
  }

  async performLogin(token: string): Promise<LoginResult> {
    const data = verifyMagicToken(token);
    if (!data) throw new Error("email: invalid or expired magic link token");

    const profile = await getUserProfile(data.userId);
    return {
      userId: data.userId,
      name: profile?.name ?? data.email,
      avatarUrl: profile?.avatarUrl ?? null,
      isAdmin: profile?.isAdmin ?? false,
    };
  }

  // ── User lookup ───────────────────────────────────────────────────────────

  async getUserInfo(platformUserId: string): Promise<PlatformUserInfo> {
    return { platformUserId, name: platformUserId };
  }

  // ── Direct message output ─────────────────────────────────────────────────

  async sendDirectMessage(platformUserId: string, msg: PlatformMessage): Promise<void> {
    const html = typeof msg.richContent === "string"
      ? msg.richContent
      : buildNotificationEmail({
          title: msg.title ?? "后台通知",
          body: msg.text,
          ctaLabel: msg.primaryUrl ? "查看详情" : undefined,
          ctaUrl: msg.primaryUrl,
        });
    await sendEmail({
      to: platformUserId,
      subject: msg.title ?? "后台通知",
      html,
      text: msg.text,
    });
  }

  // ── Deep link ─────────────────────────────────────────────────────────────

  buildActionUrl(path: string, params?: Record<string, string>): string {
    const q = params ? "?" + new URLSearchParams(params).toString() : "";
    return `${path}${q}`;
  }

  // ── InboundGateway ────────────────────────────────────────────────────────

  verifyRequest(_payload: unknown, headers: Record<string, string>): boolean {
    const secret = process.env.EMAIL_INBOUND_SECRET;
    if (!secret) return false;
    return headers["authorization"] === `Bearer ${secret}`;
  }

  async process(payload: unknown): Promise<GatewayResult> {
    return { type: "discarded", reason: "email inbound routing not implemented", raw: payload };
  }
}

export const emailPlatform = new EmailPlatform();
