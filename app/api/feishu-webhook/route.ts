import { NextRequest, NextResponse } from "next/server";
import { getTenantAccessToken, getBotOpenId } from "@/lib/feishu-auth";
import { getUserName, isBotTester } from "@/lib/feishu-webhook";
import { processMessage as agentProcessMessage, processButtonClick } from "@/agent/index";
import type { BotContext, HistoryMessage } from "@/agent/types";

const FEISHU_BASE = "https://open.feishu.cn/open-apis";
const HISTORY_SIZE = parseInt(process.env.FEISHU_HISTORY_SIZE ?? "20", 10);

// ─── Feishu API helpers ───────────────────────────────────────────────────────

async function getChatInfo(chatId: string, token: string): Promise<{ name: string; memberCount?: number }> {
  try {
    const res = await fetch(
      `${FEISHU_BASE}/im/v1/chats/${chatId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json() as { code: number; data?: { name?: string; member_count?: number } };
    return { name: data.data?.name ?? chatId, memberCount: data.data?.member_count };
  } catch {
    return { name: chatId };
  }
}

async function getChatHistory(chatId: string, token: string) {
  try {
    const url = new URL(`${FEISHU_BASE}/im/v1/messages`);
    url.searchParams.set("container_id_type", "chat");
    url.searchParams.set("container_id", chatId);
    url.searchParams.set("sort_type", "ByCreateTimeDesc");
    url.searchParams.set("page_size", String(HISTORY_SIZE));
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json() as {
      code: number;
      msg?: string;
      data?: {
        items?: {
          message_id: string;
          msg_type: string;
          create_time: string;
          sender: { id: string; sender_type: string };
          body: { content: string };
        }[];
      };
    };
    if (data.code !== 0) {
      console.error(`[getChatHistory] code=${data.code} msg=${data.msg}`);
      return [];
    }
    return data.data?.items ?? [];
  } catch (e) {
    console.error("[getChatHistory] exception:", e);
    return [];
  }
}

// ─── Content extraction ───────────────────────────────────────────────────────

function parseContent(msgType: string, rawContent: string): Pick<HistoryMessage, "type" | "text" | "cardTitle"> {
  try {
    const parsed = JSON.parse(rawContent);
    if (msgType === "text") return { type: "text", text: parsed.text ?? "" };
    if (msgType === "interactive") {
      const title =
        parsed.header?.title?.content ??
        parsed.card?.header?.title?.content ??
        "(卡片)";
      return { type: "card", cardTitle: title };
    }
  } catch { /* malformed content */ }
  return { type: "other" };
}

function stripBotMention(
  text: string,
  mentions: { key: string; id: { open_id: string } }[],
  botOpenId: string,
): string {
  const m = mentions.find(m => m.id.open_id === botOpenId);
  return m ? text.replace(m.key, "").trim() : text;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  const header = body.header as { event_type?: string } | undefined;

  if (header?.event_type === "card.action.trigger") {
    return handleCardAction(body);
  }

  if (header?.event_type !== "im.message.receive_v1") {
    return NextResponse.json({ ok: true });
  }

  void processMessage(body).catch(err =>
    console.error("[feishu-webhook] unhandled error:", err),
  );

  return NextResponse.json({ ok: true });
}

async function handleCardAction(body: Record<string, unknown>): Promise<NextResponse> {
  console.log("[feishu-webhook] card action:", JSON.stringify(body));

  const event = body.event as {
    operator?: { open_id?: string };
    action?:   { value?: Record<string, string> };
    context?:  { open_chat_id?: string };
  } | undefined;

  const operatorOpenId = event?.operator?.open_id ?? "";
  const actionValue    = event?.action?.value ?? {};
  const { session_key, button_value = "", button_label = "" } = actionValue;

  if (!session_key) {
    console.warn("[feishu-webhook] card action missing session_key");
    return NextResponse.json({ toast: { type: "error", content: "无效的按钮" } });
  }

  // Tester gate
  const allowed = await isBotTester(operatorOpenId);
  if (!allowed) {
    console.log(`[feishu-webhook] card action dropped: non-tester ${operatorOpenId}`);
    return NextResponse.json({});
  }

  const result = await processButtonClick(session_key, button_value, button_label);

  if (result === "not_found" || result === "expired") {
    return NextResponse.json({ toast: { type: "error", content: "按钮已失效，请重新发起请求。" } });
  }

  return NextResponse.json({ toast: { type: "info", content: "正在处理…" } });
}

async function processMessage(body: Record<string, unknown>) {
  const event = body.event as {
    message: {
      message_id: string;
      chat_id: string;
      chat_type: "p2p" | "group";
      message_type: string;
      content: string;
      create_time: string;
      mentions?: { key: string; id: { open_id: string }; name: string }[];
    };
    sender: {
      sender_id: { open_id: string };
      sender_type: string;
    };
  };

  const { message, sender } = event;
  const senderId = sender.sender_id.open_id;

  // Tester gate: drop if test mode is on and sender is not whitelisted
  const allowed = await isBotTester(senderId);
  if (!allowed) {
    console.log(`[feishu-webhook] dropped message from non-tester ${senderId}`);
    return;
  }

  const chatId = message.chat_id;
  const chatType = message.chat_type;

  const [token, botOpenId] = await Promise.all([
    getTenantAccessToken(),
    getBotOpenId(),
  ]);

  // In group chats, only respond when the bot is explicitly @mentioned
  if (chatType === "group") {
    const mentioned = botOpenId
      ? (message.mentions ?? []).some(m => m.id.open_id === botOpenId)
      : false;
    if (!mentioned) {
      console.log("[feishu-webhook] group message without bot mention — ignored");
      return;
    }
  }

  const triggerParsed = parseContent(message.message_type, message.content);
  const rawText = triggerParsed.text ?? "";
  const cleanText = (botOpenId
    ? stripBotMention(rawText, message.mentions ?? [], botOpenId)
    : rawText
  ).replace(/@_user_\d+/g, "").trim();

  const [senderName, chatInfo, rawHistory] = await Promise.all([
    getUserName(senderId),
    getChatInfo(chatId, token),
    getChatHistory(chatId, token),
  ]);

  const userSenderIds = [
    ...new Set(
      rawHistory
        .filter(m => m.sender.sender_type === "user" && m.sender.id !== senderId)
        .map(m => m.sender.id),
    ),
  ];
  const nameMap = new Map<string, string>([[senderId, senderName]]);
  await Promise.all(
    userSenderIds.map(async id => {
      nameMap.set(id, await getUserName(id));
    }),
  );

  const history: HistoryMessage[] = rawHistory
    .filter(m => m.message_id !== message.message_id) // exclude trigger message (appears separately as user role)
    .map(m => {
      const isUser = m.sender.sender_type === "user";
      const parsed = parseContent(m.msg_type, m.body.content);
      // Strip Feishu internal mention placeholders (@_user_N) from history text
      if (parsed.type === "text" && parsed.text) {
        parsed.text = parsed.text.replace(/@_user_\d+/g, "").trim();
      }
      return {
        messageId: m.message_id,
        senderId: m.sender.id,
        senderName: isUser ? (nameMap.get(m.sender.id) ?? m.sender.id) : "Bot",
        senderType: isUser ? "user" : "app",
        timestamp: parseInt(m.create_time),
        ...parsed,
      };
    });

  const ctx: BotContext = {
    trigger: {
      messageId: message.message_id,
      chatId,
      chatType,
      senderId,
      senderName,
      text: cleanText,
      rawText,
      timestamp: parseInt(message.create_time),
    },
    chat: chatInfo,
    history,
  };

  await agentProcessMessage(ctx);
}
