export type PlatformId = "feishu" | "email" | "wechat" | "slack" | "dingtalk";

// richContent carries platform-specific rich format (feishu card JSON, email HTML, etc.).
// Each adapter's send methods inspect richContent first; fall back to text/title/primaryUrl.
export interface PlatformMessage {
  text: string;
  title?: string;
  primaryUrl?: string;
  actions?: MessageAction[];
  richContent?: unknown;
}

export interface MessageAction {
  label: string;
  url: string;
  style?: "primary" | "danger" | "default";
}

export interface InteractionOption {
  key: string;
  label: string;
  style?: "primary" | "danger" | "default";
  contextToken?: string;
}

export interface AuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface PlatformIdentity {
  platformUserId: string;
  name: string;
  avatarUrl?: string;
  email?: string;
  auth?: AuthToken;
}

export interface PlatformUserInfo {
  platformUserId: string;
  name: string;
  avatarUrl?: string;
  email?: string;
  mobile?: string;
  _platformAdminHint?: boolean;
}

export interface GroupInfo {
  platformGroupId: string;
  name: string;
  memberCount?: number;
}

export interface ReceivedMessage {
  messageId: string;
  senderId: string;
  text: string;
  sentAt: Date;
  raw: unknown;
}

// ── Event types ───────────────────────────────────────────────────────────────

// Events routed to PersonalChannel: user-initiated DMs and card interactions.
export type PersonalEvent =
  | { type: "direct_message";       senderId: string; text: string; raw: unknown }
  | { type: "interaction_response"; promptId: string; selectedKey: string; responderId: string; contextToken?: string; raw: unknown };

// Events routed to OrgChannel: group messages and user directory changes.
export type OrgEvent =
  | { type: "group_message"; senderId: string; groupId: string; text: string; mentioned: boolean; raw: unknown }
  | { type: "user_created";  user: PlatformUserInfo; raw: unknown }
  | { type: "user_updated";  user: Partial<PlatformUserInfo> & { platformUserId: string }; raw: unknown };

export type GatewayResult =
  | { type: "verification"; challenge: string }
  | { type: "routed";    to: "personal" | "org"; event: PersonalEvent | OrgEvent }
  | { type: "discarded"; reason: string; raw: unknown };

// ── Capability types ──────────────────────────────────────────────────────────

export interface PersonalCapabilities {
  canLogin: boolean;
  canSendDirect: boolean;
  supportsInteractiveMessages: boolean;
  supportsRichMessages: boolean;
}

export interface OrgCapabilities {
  canCreateGroup: boolean;
  canBindExistingGroup: boolean;
  canManageGroupMembers: boolean;
  canReadMessageHistory: boolean;
  canSyncUserDirectory: boolean;
  supportsGroupWebhook: boolean;
  supportsRichMessages: boolean;
}

// ── PersonalChannel: user-scoped I/O ─────────────────────────────────────────
// Decision maker: the user themselves.
// Config source: notification_preference → user_platform_identity.
export interface PersonalChannel {
  readonly platformId: PlatformId;
  readonly capabilities: PersonalCapabilities;

  // === Auth ===
  generateAuthUrl(state: string, redirectUri: string): string;
  handleAuthCallback(code: string): Promise<PlatformIdentity>;
  refreshAuth?(refreshToken: string): Promise<AuthToken>;
  getBotIdentity?(): Promise<PlatformIdentity>;

  // === User lookup ===
  getUserInfo(platformUserId: string): Promise<PlatformUserInfo>;

  // === Direct message output ===
  sendDirectMessage(platformUserId: string, msg: PlatformMessage): Promise<void>;
  sendInteractivePrompt?(
    platformUserId: string,
    msg: PlatformMessage,
    options: InteractionOption[],
  ): Promise<string>; // returns promptId

  // === Deep link ===
  buildActionUrl(path: string, params?: Record<string, string>): string;

  // === Inbound personal event handler (called by InboundGateway) ===
  handlePersonalEvent?(event: PersonalEvent): Promise<void>;
}

// ── OrgChannel: org-scoped I/O ───────────────────────────────────────────────
// Decision maker: production admin.
// Config source: production_platform_channel.
export interface OrgChannel {
  readonly platformId: PlatformId;
  readonly capabilities: OrgCapabilities;

  // === User directory (org-managed) ===
  readonly onboardingStrategy: "direct_sync" | "invite_link";
  importAllUsers?(): AsyncIterable<PlatformUserInfo>;
  searchUsers?(query: string): Promise<PlatformUserInfo[]>;

  // === Group lifecycle ===
  createGroup?(name: string, memberIds: string[], ownerId: string): Promise<string>;
  ensureGroupReady?(groupId: string, ownerId: string): Promise<void>;
  bindGroup?(platformGroupId: string): Promise<GroupInfo>;
  searchGroups?(query: string): Promise<GroupInfo[]>;
  getGroupInfo?(groupId: string): Promise<GroupInfo>;
  renameGroup?(groupId: string, name: string): Promise<void>;
  leaveGroup?(groupId: string): Promise<void>;

  // === Group members ===
  addGroupMembers?(groupId: string, memberIds: string[]): Promise<void>;
  removeGroupMember?(groupId: string, memberId: string): Promise<void>;
  listGroupMembers?(groupId: string): Promise<PlatformUserInfo[]>;

  // === Group message output ===
  sendGroupMessage(groupId: string, msg: PlatformMessage): Promise<void>;
  sendInteractivePromptToGroup?(
    groupId: string,
    msg: PlatformMessage,
    options: InteractionOption[],
  ): Promise<string>;

  // === Message history ===
  getMessageHistory?(groupId: string, limit: number): Promise<ReceivedMessage[]>;
  getMessage?(messageId: string): Promise<ReceivedMessage>;

  // === Inbound org event handler (called by InboundGateway) ===
  handleOrgEvent?(event: OrgEvent): Promise<void>;
}

// Lightweight handler objects passed to InboundGateway.process().
// Decoupled from the full channel interfaces so callers can pass inline handlers
// (e.g. agent dispatch in the webhook route) without implementing the full interface.
// PersonalChannel / OrgChannel objects satisfy these types via structural compatibility.
export type PersonalEventHandler = {
  handlePersonalEvent?: (event: PersonalEvent) => Promise<void>;
};

export type OrgEventHandler = {
  handleOrgEvent?: (event: OrgEvent) => Promise<void>;
};

// ── InboundGateway: raw external input → routed events ───────────────────────
// Parses platform-specific webhook payloads (or polls) and routes each event to
// PersonalChannel or OrgChannel. All platform-specific routing logic lives here:
// email header analysis, WeChat bot quirks, Feishu chat_type checks, etc.
export interface InboundGateway {
  readonly platformId: PlatformId;

  // Authenticate the incoming request (signature check, IP whitelist, etc.)
  verifyRequest(payload: unknown, headers: Record<string, string>): boolean;

  // Parse raw payload, classify event, call the appropriate handler, return result for logging
  process(
    payload: unknown,
    channels: { personal?: PersonalEventHandler; org?: OrgEventHandler },
  ): Promise<GatewayResult>;

  // For polling-based platforms (e.g. email IMAP)
  poll?(channels: { personal?: PersonalEventHandler; org?: OrgEventHandler }): AsyncIterable<void>;
}
