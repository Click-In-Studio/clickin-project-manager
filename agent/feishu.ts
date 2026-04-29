const FEISHU_BASE = "https://open.feishu.cn/open-apis";

async function getTenantAccessToken(): Promise<string> {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) throw new Error("FEISHU_APP_ID / FEISHU_APP_SECRET not set");
  const res = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json() as { code: number; msg: string; tenant_access_token: string };
  if (data.code !== 0) throw new Error(`tenant_access_token: ${data.msg}`);
  return data.tenant_access_token;
}

export async function sendMessage(
  receiveId: string,
  receiveIdType: "open_id" | "chat_id",
  msgType: "text" | "interactive",
  content: string,
): Promise<void> {
  const token = await getTenantAccessToken();
  const res = await fetch(
    `${FEISHU_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ receive_id: receiveId, msg_type: msgType, content }),
    },
  );
  const data = await res.json() as { code: number; msg: string };
  if (data.code !== 0) throw new Error(`Feishu sendMessage error ${data.code}: ${data.msg}`);
}

export async function getUserDisplayName(openId: string): Promise<string> {
  try {
    const token = await getTenantAccessToken();
    const res = await fetch(
      `${FEISHU_BASE}/contact/v3/users/${openId}?user_id_type=open_id`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json() as { code: number; data?: { user?: { name?: string } } };
    return data.data?.user?.name ?? openId;
  } catch {
    return openId;
  }
}

export type ChatHistoryMessage = {
  messageId:  string;
  senderId:   string;
  senderName: string;
  senderType: "user" | "app";
  timestamp:  number;
  type:       "text" | "card" | "other";
  text?:      string;
  cardTitle?: string;
};

export async function getChatMessages(chatId: string, count: number): Promise<ChatHistoryMessage[]> {
  const token = await getTenantAccessToken();
  const url = new URL(`${FEISHU_BASE}/im/v1/messages`);
  url.searchParams.set("container_id_type", "chat");
  url.searchParams.set("container_id", chatId);
  url.searchParams.set("sort_type", "ByCreateTimeDesc");
  url.searchParams.set("page_size", String(Math.min(count, 50)));

  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json() as {
    code: number; msg?: string;
    data?: { items?: { message_id: string; msg_type: string; create_time: string; sender: { id: string; sender_type: string }; body: { content: string } }[] };
  };
  if (data.code !== 0) throw new Error(`getChatMessages error ${data.code}: ${data.msg}`);

  const items = data.data?.items ?? [];
  const uniqueUserIds = [...new Set(items.filter(m => m.sender.sender_type === "user").map(m => m.sender.id))];
  const nameMap = new Map<string, string>();
  await Promise.all(uniqueUserIds.map(async id => nameMap.set(id, await getUserDisplayName(id))));

  return items.reverse().map(m => {
    const isUser = m.sender.sender_type === "user";
    let type: "text" | "card" | "other" = "other";
    let text: string | undefined;
    let cardTitle: string | undefined;
    try {
      const parsed = JSON.parse(m.body.content);
      if (m.msg_type === "text") {
        type = "text";
        text = (parsed.text ?? "").replace(/@_user_\d+/g, "").trim();
      } else if (m.msg_type === "interactive") {
        type = "card";
        cardTitle = parsed.header?.title?.content ?? parsed.card?.header?.title?.content ?? "(卡片)";
      }
    } catch { /* ignore */ }
    return {
      messageId:  m.message_id,
      senderId:   m.sender.id,
      senderName: isUser ? (nameMap.get(m.sender.id) ?? m.sender.id) : "助手",
      senderType: isUser ? "user" as const : "app" as const,
      timestamp:  parseInt(m.create_time),
      type, text, cardTitle,
    };
  });
}

// Lightweight: only fetches open_ids (no name resolution). First page, up to 100.
export async function getChatMemberOpenIds(chatId: string): Promise<{ openIds: string[]; hasMore: boolean }> {
  const token = await getTenantAccessToken();
  const url = new URL(`${FEISHU_BASE}/im/v1/chats/${chatId}/members`);
  url.searchParams.set("member_id_type", "open_id");
  url.searchParams.set("page_size", "100");
  const res  = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json() as {
    code: number; msg: string;
    data?: { items?: { member_id: string; member_id_type: string }[]; has_more?: boolean };
  };
  if (data.code !== 0) throw new Error(`getChatMemberOpenIds error ${data.code}: ${data.msg}`);
  const openIds = (data.data?.items ?? [])
    .filter(m => m.member_id_type === "open_id")
    .map(m => m.member_id);
  return { openIds, hasMore: data.data?.has_more ?? false };
}

export type ChatDetailInfo = {
  name: string;
  memberCount: number;
  ownerId: string;
  ownerName: string;
  adminNames: string[];
  members: { openId: string; name: string }[];
  hasMoreMembers: boolean;
};

export async function getChatDetail(chatId: string): Promise<ChatDetailInfo> {
  const token = await getTenantAccessToken();

  // Basic chat info
  const chatRes = await fetch(`${FEISHU_BASE}/im/v1/chats/${chatId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const chatData = await chatRes.json() as {
    code: number; msg: string;
    data?: { name?: string; member_count?: number; owner_id?: string };
  };
  if (chatData.code !== 0) throw new Error(`getChatDetail ${chatData.code}: ${chatData.msg}`);

  const name        = chatData.data?.name ?? chatId;
  const memberCount = chatData.data?.member_count ?? 0;
  const ownerId     = chatData.data?.owner_id ?? "";

  // Member list (first page, up to 100)
  const membersUrl = new URL(`${FEISHU_BASE}/im/v1/chats/${chatId}/members`);
  membersUrl.searchParams.set("member_id_type", "open_id");
  membersUrl.searchParams.set("page_size", "100");
  const membersRes  = await fetch(membersUrl.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const membersData = await membersRes.json() as {
    code: number; msg: string;
    data?: { items?: { member_id: string; name: string }[]; has_more?: boolean };
  };

  const members        = (membersData.data?.items ?? []).map(m => ({ openId: m.member_id, name: m.name || m.member_id }));
  const hasMoreMembers = membersData.data?.has_more ?? false;

  // Owner name: prefer from member list, fall back to contact API
  const ownerName = members.find(m => m.openId === ownerId)?.name ?? await getUserDisplayName(ownerId);

  // Managers/admins (best effort — endpoint may return empty for bots without admin scope)
  let adminNames: string[] = [];
  try {
    const mgUrl = new URL(`${FEISHU_BASE}/im/v1/chats/${chatId}/managers`);
    mgUrl.searchParams.set("member_id_type", "open_id");
    const mgRes  = await fetch(mgUrl.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const mgData = await mgRes.json() as {
      code: number;
      data?: { chat_managers?: { member_id: string }[] };
    };
    if (mgData.code === 0 && mgData.data?.chat_managers?.length) {
      adminNames = await Promise.all(
        mgData.data.chat_managers.map(m =>
          members.find(mm => mm.openId === m.member_id)?.name ?? getUserDisplayName(m.member_id),
        ),
      );
    }
  } catch { /* admin info unavailable */ }

  return { name, memberCount, ownerId, ownerName, adminNames, members, hasMoreMembers };
}

export type FetchedMessage = {
  messageId: string;
  msgType:   string;
  content:   string; // raw JSON string from Feishu
};

export async function getMessage(messageId: string): Promise<FetchedMessage> {
  const token = await getTenantAccessToken();
  const res = await fetch(`${FEISHU_BASE}/im/v1/messages/${messageId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json() as {
    code: number;
    msg:  string;
    data?: {
      items?: { message_id: string; msg_type: string; body: { content: string } }[];
    };
  };
  if (data.code !== 0) throw new Error(`Feishu getMessage error ${data.code}: ${data.msg}`);
  const item = data.data?.items?.[0];
  if (!item) throw new Error(`getMessage: no item returned for ${messageId}`);
  return { messageId: item.message_id, msgType: item.msg_type, content: item.body.content };
}
