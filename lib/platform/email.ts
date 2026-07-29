import { signMagicToken, verifyMagicToken } from "../auth-email";
import { sendEmail } from "../email";
import { upsertEmailUser, getUserProfile } from "../db";
import type {
  PersonalChannel,
  PersonalCapabilities,
  InboundGateway,
  GatewayResult,
  PlatformIdentity,
  PlatformMessage,
  PlatformUserInfo,
  LoginResult,
} from "./types";

const MAGIC_LINK_PATH = "/api/auth/email/callback";

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
    const name = params.name?.trim() || email;
    if (!email) throw new Error("email: missing email param");

    const { userId } = await upsertEmailUser(email, name);
    const token = signMagicToken(userId, email);

    const baseUrl = context?.baseUrl ?? "";
    const magicLink = `${baseUrl}${MAGIC_LINK_PATH}?token=${encodeURIComponent(token)}`;

    await sendEmail({
      to: email,
      subject: "登录 Click-In 后台",
      html: `
        <p>点击下方链接登录 Click-In 后台管理系统：</p>
        <p><a href="${magicLink}" style="font-size:16px;font-weight:bold">点击登录</a></p>
        <p style="color:#888;font-size:12px">链接 15 分钟内有效，请勿转发。</p>
      `,
      text: `点击以下链接登录 Click-In 后台（15 分钟内有效）：\n\n${magicLink}`,
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
    const html = typeof msg.richContent === "string" ? msg.richContent : `<p>${msg.text}</p>`;
    await sendEmail({
      to: platformUserId,
      subject: msg.title ?? "Click-In 通知",
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

  async process(
    payload: unknown,
  ): Promise<GatewayResult> {
    // Inbound email: no routing logic yet — discard
    return { type: "discarded", reason: "email inbound routing not implemented", raw: payload };
  }
}

export const emailPlatform = new EmailPlatform();
