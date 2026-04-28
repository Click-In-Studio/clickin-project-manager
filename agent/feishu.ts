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
