import {
  buildOAuthUrl,
  exchangeCode,
  getUserInfo as feishuGetUserInfo,
  getBotOpenId,
  getAppAccessToken,
  getTenantAccessToken,
  fetchAllTenantUsersRaw,
  searchUsersByName,
  type FeishuRawUser,
} from "../feishu-auth";
import {
  sendBotDm,
  sendCard,
  sendChatCard,
} from "../feishu-bot";
import {
  createChat,
  addChatMembers,
  removeChatMember,
  getChatMemberOpenIds,
  updateChatName,
  searchChats,
} from "../feishu-chat";
import type {
  PersonalChannel,
  PersonalCapabilities,
  PersonalEventHandler,
  OrgChannel,
  OrgCapabilities,
  OrgEventHandler,
  InboundGateway,
  GatewayResult,
  PersonalEvent,
  OrgEvent,
  PlatformIdentity,
  PlatformMessage,
  PlatformUserInfo,
  GroupInfo,
  ReceivedMessage,
  InteractionOption,
  AuthToken,
} from "./types";

const FEISHU_BASE = "https://open.feishu.cn/open-apis";

function appId(): string {
  const v = process.env.FEISHU_APP_ID;
  if (!v) throw new Error("FEISHU_APP_ID is not set");
  return v;
}

function rawToUserInfo(u: FeishuRawUser): PlatformUserInfo {
  return {
    platformUserId: u.openId,
    name: u.name,
    avatarUrl: u.avatarUrl ?? undefined,
    email: u.email ?? undefined,
    mobile: u.phone ?? undefined,
  };
}

export class FeishuPlatform implements PersonalChannel, OrgChannel, InboundGateway {
  readonly platformId = "feishu" as const;
  readonly onboardingStrategy = "direct_sync" as const;

  // Satisfies both PersonalCapabilities and OrgCapabilities (intersection).
  readonly capabilities: PersonalCapabilities & OrgCapabilities = {
    canLogin: true,
    canSendDirect: true,
    supportsInteractiveMessages: true,
    supportsRichMessages: true,
    canCreateGroup: true,
    canBindExistingGroup: true,
    canManageGroupMembers: true,
    canReadMessageHistory: true,
    canSyncUserDirectory: true,
    supportsGroupWebhook: true,
  };

  // ── Auth ──────────────────────────────────────────────────────────────────

  generateAuthUrl(state: string, redirectUri: string): string {
    return buildOAuthUrl(state, redirectUri);
  }

  async handleAuthCallback(code: string): Promise<PlatformIdentity> {
    const tokenData = await exchangeCode(code);
    const info = await feishuGetUserInfo(tokenData.userAccessToken);
    if (!info) throw new Error("feishu: failed to fetch user info after auth");
    return {
      platformUserId: info.openId,
      name: info.name,
      avatarUrl: info.avatarUrl ?? undefined,
      auth: {
        accessToken: tokenData.userAccessToken,
        expiresAt: tokenData.expiry,
      },
    };
  }

  async getBotIdentity(): Promise<PlatformIdentity> {
    const openId = await getBotOpenId();
    if (!openId) throw new Error("feishu: could not retrieve bot open_id");
    return { platformUserId: openId, name: "Bot" };
  }

  // ── User lookup ───────────────────────────────────────────────────────────

  async getUserInfo(platformUserId: string): Promise<PlatformUserInfo> {
    const token = await getAppAccessToken();
    const res = await fetch(
      `${FEISHU_BASE}/contact/v3/users/${platformUserId}?user_id_type=open_id`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json() as {
      code: number;
      data?: { user?: { name?: string; avatar?: { avatar_240?: string }; email?: string; mobile?: string; is_tenant_manager?: boolean } };
    };
    if (data.code !== 0 || !data.data?.user) {
      return { platformUserId, name: platformUserId };
    }
    const u = data.data.user;
    return {
      platformUserId,
      name: u.name ?? platformUserId,
      avatarUrl: u.avatar?.avatar_240,
      email: u.email,
      mobile: u.mobile,
      _platformAdminHint: u.is_tenant_manager,
    };
  }

  async searchUsers(query: string): Promise<PlatformUserInfo[]> {
    const results = await searchUsersByName(query);
    return results.map(rawToUserInfo);
  }

  // ── User directory import ─────────────────────────────────────────────────

  async *importAllUsers(): AsyncIterable<PlatformUserInfo> {
    const users = await fetchAllTenantUsersRaw();
    for (const u of users) yield rawToUserInfo(u);
  }

  // ── Direct messages ───────────────────────────────────────────────────────

  async sendDirectMessage(platformUserId: string, msg: PlatformMessage): Promise<void> {
    if (msg.richContent !== undefined) {
      await sendCard(platformUserId, msg.richContent as object);
    } else {
      await sendBotDm(platformUserId, msg.text);
    }
  }

  // ── Interactive messages ──────────────────────────────────────────────────

  async sendInteractivePrompt(
    platformUserId: string,
    msg: PlatformMessage,
    options: InteractionOption[],
  ): Promise<string> {
    return this._sendInteractive(platformUserId, "open_id", msg, options);
  }

  async sendInteractivePromptToGroup(
    groupId: string,
    msg: PlatformMessage,
    options: InteractionOption[],
  ): Promise<string> {
    return this._sendInteractive(groupId, "chat_id", msg, options);
  }

  private async _sendInteractive(
    receiveId: string,
    receiveIdType: "open_id" | "chat_id",
    msg: PlatformMessage,
    options: InteractionOption[],
  ): Promise<string> {
    const actions = options.map((opt) => ({
      tag: "button",
      text: { tag: "plain_text", content: opt.label },
      type: opt.style === "danger" ? "danger" : opt.style === "primary" ? "primary" : "default",
      value: { key: opt.key, ...(opt.contextToken ? { context_token: opt.contextToken } : {}) },
    }));

    const card = msg.richContent ?? {
      config: { wide_screen_mode: true },
      header: msg.title ? { title: { tag: "plain_text", content: msg.title }, template: "blue" } : undefined,
      elements: [
        { tag: "div", text: { tag: "lark_md", content: msg.text } },
        ...(actions.length ? [{ tag: "action", actions }] : []),
      ],
    };

    const token = await getAppAccessToken();
    const res = await fetch(`${FEISHU_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    });
    const data = await res.json() as { code: number; msg: string; data?: { message_id?: string } };
    if (data.code !== 0) throw new Error(`feishu sendInteractive: ${data.msg}`);
    return data.data?.message_id ?? "";
  }

  // ── Group lifecycle ───────────────────────────────────────────────────────

  async createGroup(name: string, memberIds: string[], ownerId: string): Promise<string> {
    const chatId = await createChat(name, ownerId, memberIds);
    if (!chatId) throw new Error(`feishu: createGroup failed for "${name}"`);
    return chatId;
  }

  // Feishu-specific: restricted dept group (only owner/admin can add members).
  // Not part of the OrgChannel interface — callers import feishuPlatform directly.
  async createDeptGroup(name: string, memberIds: string[], ownerId: string): Promise<string> {
    const chatId = await createChat(name, ownerId, memberIds, "only_owner_and_administrator");
    if (!chatId) throw new Error(`feishu: createDeptGroup failed for "${name}"`);
    return chatId;
  }

  async ensureGroupReady(groupId: string, ownerId: string): Promise<void> {
    // Ensure the bot is a manager. Best-effort — errors are non-fatal.
    try {
      const tenantToken = await getTenantAccessToken();
      await fetch(`${FEISHU_BASE}/im/v1/chats/${groupId}/managers/add_managers?member_id_type=app_id`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tenantToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ manager_ids: [appId()] }),
      });
    } catch (e) {
      console.warn("[feishu] ensureGroupReady: could not add bot as manager", e);
    }
    void ownerId; // owner management handled at creation time
  }

  async bindGroup(platformGroupId: string): Promise<GroupInfo> {
    return (await this.getGroupInfo!(platformGroupId))!;
  }

  async searchGroups(query: string): Promise<GroupInfo[]> {
    const results = await searchChats(query);
    return results.map((r) => ({ platformGroupId: r.chatId, name: r.name }));
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo> {
    const token = await getTenantAccessToken();
    const res = await fetch(`${FEISHU_BASE}/im/v1/chats/${groupId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json() as {
      code: number;
      data?: { name?: string; member_count?: number };
    };
    if (data.code !== 0) throw new Error(`feishu: getGroupInfo(${groupId}) failed`);
    return {
      platformGroupId: groupId,
      name: data.data?.name ?? groupId,
      memberCount: data.data?.member_count,
    };
  }

  async renameGroup(groupId: string, name: string): Promise<void> {
    await updateChatName(groupId, name);
  }

  async leaveGroup(groupId: string): Promise<void> {
    const token = await getTenantAccessToken();
    await fetch(`${FEISHU_BASE}/im/v1/chats/${groupId}/members/me_leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
  }

  // ── Group members ─────────────────────────────────────────────────────────

  async addGroupMembers(groupId: string, userIds: string[]): Promise<void> {
    await addChatMembers(groupId, userIds);
  }

  async removeGroupMember(groupId: string, userId: string): Promise<void> {
    await removeChatMember(groupId, userId);
  }

  async listGroupMembers(groupId: string): Promise<PlatformUserInfo[]> {
    const openIds = await getChatMemberOpenIds(groupId);
    return openIds.map((id) => ({ platformUserId: id, name: id }));
  }

  // ── Group messaging ───────────────────────────────────────────────────────

  async sendGroupMessage(groupId: string, msg: PlatformMessage): Promise<void> {
    if (msg.richContent !== undefined) {
      await sendChatCard(groupId, msg.richContent as object);
    } else {
      const token = await getTenantAccessToken();
      await fetch(`${FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          receive_id: groupId,
          msg_type: "text",
          content: JSON.stringify({ text: msg.text }),
        }),
      });
    }
  }

  // ── Message history ───────────────────────────────────────────────────────

  async getMessageHistory(groupId: string, limit: number): Promise<ReceivedMessage[]> {
    const token = await getTenantAccessToken();
    const url = new URL(`${FEISHU_BASE}/im/v1/messages`);
    url.searchParams.set("container_id_type", "chat");
    url.searchParams.set("container_id", groupId);
    url.searchParams.set("sort_type", "ByCreateTimeDesc");
    url.searchParams.set("page_size", String(limit));
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json() as {
      code: number;
      data?: { items?: { message_id: string; sender: { id: string }; body: { content: string }; create_time: string }[] };
    };
    if (data.code !== 0) return [];
    return (data.data?.items ?? []).map((item) => {
      let text = "";
      try { text = (JSON.parse(item.body.content) as { text?: string }).text ?? ""; } catch { /* ignore */ }
      return {
        messageId: item.message_id,
        senderId: item.sender.id,
        text,
        sentAt: new Date(Number(item.create_time)),
        raw: item,
      };
    });
  }

  async getMessage(messageId: string): Promise<ReceivedMessage> {
    const token = await getTenantAccessToken();
    const res = await fetch(`${FEISHU_BASE}/im/v1/messages/${messageId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json() as {
      code: number;
      data?: { items?: { message_id: string; sender: { id: string }; body: { content: string }; create_time: string }[] };
    };
    if (data.code !== 0 || !data.data?.items?.[0]) throw new Error(`feishu: getMessage(${messageId}) failed`);
    const item = data.data.items[0];
    let text = "";
    try { text = (JSON.parse(item.body.content) as { text?: string }).text ?? ""; } catch { /* ignore */ }
    return { messageId: item.message_id, senderId: item.sender.id, text, sentAt: new Date(Number(item.create_time)), raw: item };
  }

  // ── Platform action URL ───────────────────────────────────────────────────

  buildActionUrl(path: string, params?: Record<string, string>): string {
    const id = appId();
    let fullPath = path;
    if (params && Object.keys(params).length > 0) {
      const qs = new URLSearchParams(params).toString();
      fullPath = `${path}${path.includes("?") ? "&" : "?"}${qs}`;
    }
    return `https://applink.feishu.cn/client/web_app/open?appId=${id}&path=${encodeURIComponent(fullPath)}`;
  }

  // ── InboundGateway ────────────────────────────────────────────────────────

  verifyRequest(payload: unknown, _headers: Record<string, string>): boolean {
    // url_verification handshake carries no signing headers — always allow through.
    if ((payload as Record<string, unknown>).type === "url_verification") return true;
    // Future: check X-Lark-Signature with HMAC-SHA256 of the Encrypt Key.
    return true;
  }

  // Parse feishu webhook payload, classify event, route to personal/org channel.
  // Feishu's classification is API-level: p2p → personal, group → org, card action → personal.
  async process(
    payload: unknown,
    channels: { personal?: PersonalEventHandler; org?: OrgEventHandler },
  ): Promise<GatewayResult> {
    const body = payload as Record<string, unknown>;

    if (body.type === "url_verification") {
      return { type: "verification", challenge: body.challenge as string };
    }

    const header = body.header as { event_type?: string } | undefined;
    const event  = body.event as Record<string, unknown> | undefined;

    if (header?.event_type === "im.message.receive_v1" && event) {
      const msg    = event.message as Record<string, unknown>;
      const sender = event.sender  as Record<string, unknown>;
      const senderId = (sender.sender_id as Record<string, string>).open_id;
      let text = "";
      try {
        const parsed = JSON.parse(msg.content as string ?? "{}");
        text = parsed.text ?? "";
      } catch { /* ignore parse errors */ }

      if (msg.chat_type === "p2p") {
        const ev: PersonalEvent = { type: "direct_message", senderId, text, raw: body };
        await channels.personal?.handlePersonalEvent?.(ev);
        return { type: "routed", to: "personal", event: ev };
      }

      const mentioned = Array.isArray(msg.mentions) && msg.mentions.length > 0;
      const ev: OrgEvent = {
        type: "group_message",
        senderId,
        groupId: msg.chat_id as string,
        text,
        mentioned,
        raw: body,
      };
      await channels.org?.handleOrgEvent?.(ev);
      return { type: "routed", to: "org", event: ev };
    }

    if (header?.event_type === "card.action.trigger" && event) {
      const action   = event.action   as Record<string, unknown>;
      const value    = action.value   as Record<string, string>;
      const operator = event.operator as Record<string, unknown>;
      const ev: PersonalEvent = {
        type: "interaction_response",
        promptId:    (event.open_message_id as string) ?? "",
        selectedKey: value.key ?? "",
        responderId: (operator?.open_id as string) ?? "",
        contextToken: value.context_token,
        raw: body,
      };
      await channels.personal?.handlePersonalEvent?.(ev);
      return { type: "routed", to: "personal", event: ev };
    }

    if (header?.event_type === "contact.user.created_v3" && event) {
      const u      = event.object as Record<string, unknown>;
      const avatar = u.avatar as Record<string, string> | undefined;
      const ev: OrgEvent = {
        type: "user_created",
        user: {
          platformUserId: u.open_id as string,
          name:           u.name as string,
          avatarUrl:      avatar?.avatar_240,
          email:          u.email as string | undefined,
          mobile:         u.mobile as string | undefined,
          _platformAdminHint: u.is_tenant_manager as boolean | undefined,
        },
        raw: body,
      };
      await channels.org?.handleOrgEvent?.(ev);
      return { type: "routed", to: "org", event: ev };
    }

    if (header?.event_type === "contact.user.updated_v3" && event) {
      const u      = event.object as Record<string, unknown>;
      const avatar = u.avatar as Record<string, string> | undefined;
      const ev: OrgEvent = {
        type: "user_updated",
        user: {
          platformUserId: u.open_id as string,
          name:           u.name as string | undefined,
          avatarUrl:      avatar?.avatar_240,
          email:          u.email as string | undefined,
          mobile:         u.mobile as string | undefined,
          _platformAdminHint: u.is_tenant_manager as boolean | undefined,
        },
        raw: body,
      };
      await channels.org?.handleOrgEvent?.(ev);
      return { type: "routed", to: "org", event: ev };
    }

    return {
      type: "discarded",
      reason: `unknown event type: ${header?.event_type ?? "none"}`,
      raw: body,
    };
  }
}

export const feishuPlatform = new FeishuPlatform();
