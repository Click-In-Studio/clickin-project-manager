/**
 * Feishu group-chat (im/v1/chats) API helpers.
 * All functions use tenant_access_token and swallow errors — callers treat
 * failures as non-fatal.
 */

import { getTenantAccessToken } from "./feishu-auth";

const BASE = "https://open.feishu.cn/open-apis";

async function token() { return getTenantAccessToken(); }
function appId() {
  const v = process.env.FEISHU_APP_ID;
  if (!v) throw new Error("FEISHU_APP_ID is not set");
  return v;
}

// ─── Create ───────────────────────────────────────────────────────────────────

/**
 * Create a new group chat, then explicitly add all members.
 *
 * For dept chats (addMemberPermission="only_owner_and_administrator"):
 *   1. Create WITHOUT owner_id → bot becomes owner (needed so bot can promote itself)
 *   2. Add the intended human owner as a member
 *   3. Promote bot to manager (works because bot is currently the owner)
 *   4. Transfer ownership to the human
 *   5. Add remaining members
 *
 * @param addMemberPermission "all_members" (event/req) | "only_owner_and_administrator" (dept)
 */
export async function createChat(
  name: string,
  ownerOpenId: string,
  memberOpenIds: string[],
  addMemberPermission: "all_members" | "only_owner_and_administrator" = "all_members",
): Promise<string | null> {
  try {
    const isDeptChat = addMemberPermission === "only_owner_and_administrator";

    // Step 1: create the chat
    // For dept chats omit owner_id so the bot becomes owner (needed for self-promotion to manager)
    const createBody: Record<string, unknown> = {
      name,
      add_member_permission: addMemberPermission,
    };
    if (!isDeptChat) {
      createBody.owner_id = ownerOpenId;
      createBody.user_id_type = "open_id";
      createBody.user_ids = [ownerOpenId];
    }
    const res = await fetch(`${BASE}/im/v1/chats`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(createBody),
    });
    const data = await res.json() as { code: number; msg: string; data?: { chat_id: string } };
    if (data.code !== 0) {
      console.error(`[feishu-chat] createChat failed: ${data.code} ${data.msg}`);
      return null;
    }
    const chatId = data.data?.chat_id ?? null;
    if (!chatId) return null;

    if (isDeptChat) {
      // Step 2: add human owner as member
      await addChatMembers(chatId, [ownerOpenId]);
      // Step 3: promote bot to manager while bot is owner
      await addBotAsManager(chatId);
      // Step 4: transfer ownership to human
      await transferChatOwner(chatId, ownerOpenId);
    }

    // Step 5: add remaining members
    const others = [...new Set(memberOpenIds)].filter(id => id !== ownerOpenId);
    if (others.length) await addChatMembers(chatId, others);

    return chatId;
  } catch (e) {
    console.error("[feishu-chat] createChat error:", e);
    return null;
  }
}

// ─── Bot manager helpers ───────────────────────────────────────────────────────

/** Promote the bot to manager using app_id. Bot must currently be the chat owner. */
async function addBotAsManager(chatId: string): Promise<void> {
  try {
    const res = await fetch(`${BASE}/im/v1/chats/${chatId}/managers/add_managers?member_id_type=app_id`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ manager_ids: [appId()] }),
    });
    const data = await res.json() as { code: number; msg: string };
    if (data.code !== 0) console.error(`[feishu-chat] addBotAsManager(${chatId}) failed: ${data.code} ${data.msg}`);
  } catch (e) {
    console.error("[feishu-chat] addBotAsManager error:", e);
  }
}

/** Transfer chat ownership to the given user open_id. */
async function transferChatOwner(chatId: string, newOwnerOpenId: string): Promise<void> {
  try {
    const res = await fetch(`${BASE}/im/v1/chats/${chatId}?user_id_type=open_id`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ owner_id: newOwnerOpenId }),
    });
    const data = await res.json() as { code: number; msg: string };
    if (data.code !== 0) console.error(`[feishu-chat] transferChatOwner(${chatId}) failed: ${data.code} ${data.msg}`);
  } catch (e) {
    console.error("[feishu-chat] transferChatOwner error:", e);
  }
}

// ─── Managers ─────────────────────────────────────────────────────────────────

/** Add open IDs as chat managers. */
export async function addChatManagers(chatId: string, openIds: string[]): Promise<void> {
  if (!openIds.length) return;
  try {
    const res = await fetch(`${BASE}/im/v1/chats/${chatId}/managers/add_managers?member_id_type=open_id`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ manager_ids: openIds }),
    });
    const data = await res.json() as { code: number; msg: string };
    if (data.code !== 0) console.error(`[feishu-chat] addChatManagers(${chatId}) failed: ${data.code} ${data.msg}`);
  } catch (e) {
    console.error("[feishu-chat] addChatManagers error:", e);
  }
}

// ─── Members ──────────────────────────────────────────────────────────────────

/** Add open IDs to a group chat. No-op for empty list. */
export async function addChatMembers(chatId: string, openIds: string[]): Promise<void> {
  if (!openIds.length) return;
  try {
    const res = await fetch(`${BASE}/im/v1/chats/${chatId}/members`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ member_id_type: "open_id", id_list: openIds }),
    });
    const data = await res.json() as { code: number; msg: string };
    if (data.code !== 0) console.error(`[feishu-chat] addChatMembers(${chatId}) failed: ${data.code} ${data.msg}`);
  } catch (e) {
    console.error("[feishu-chat] addChatMembers error:", e);
  }
}

/** Remove a single open ID from a group chat. */
export async function removeChatMember(chatId: string, openId: string): Promise<void> {
  try {
    const res = await fetch(`${BASE}/im/v1/chats/${chatId}/members`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ member_id_type: "open_id", id_list: [openId] }),
    });
    const data = await res.json() as { code: number; msg: string };
    if (data.code !== 0) console.error(`[feishu-chat] removeChatMember(${chatId},${openId}) failed: ${data.code} ${data.msg}`);
  } catch (e) {
    console.error("[feishu-chat] removeChatMember error:", e);
  }
}

/** Get all member open IDs of a chat (paginates automatically). */
export async function getChatMemberOpenIds(chatId: string): Promise<string[]> {
  try {
    const ids: string[] = [];
    let pageToken = "";
    for (;;) {
      const url = `${BASE}/im/v1/chats/${chatId}/members?member_id_type=open_id&page_size=100${pageToken ? `&page_token=${pageToken}` : ""}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` } });
      const data = await res.json() as {
        code: number; msg: string;
        data?: { items: { member_id_type: string; member_id: string }[]; has_more: boolean; page_token: string };
      };
      if (data.code !== 0) { console.error(`[feishu-chat] getChatMembers(${chatId}) failed: ${data.code} ${data.msg}`); return []; }
      for (const item of data.data?.items ?? []) {
        if (item.member_id_type === "open_id") ids.push(item.member_id);
      }
      if (!data.data?.has_more) break;
      pageToken = data.data.page_token;
    }
    return ids;
  } catch (e) {
    console.error("[feishu-chat] getChatMembers error:", e);
    return [];
  }
}

/** Returns true if the given open ID is a member of the chat. */
export async function isUserInChat(chatId: string, openId: string): Promise<boolean> {
  const ids = await getChatMemberOpenIds(chatId);
  return ids.includes(openId);
}

// ─── Update ───────────────────────────────────────────────────────────────────

/** Rename a group chat. */
export async function updateChatName(chatId: string, name: string): Promise<void> {
  try {
    const res = await fetch(`${BASE}/im/v1/chats/${chatId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json() as { code: number; msg: string };
    if (data.code !== 0) console.error(`[feishu-chat] updateChatName(${chatId}) failed: ${data.code} ${data.msg}`);
  } catch (e) {
    console.error("[feishu-chat] updateChatName error:", e);
  }
}

// ─── Search ───────────────────────────────────────────────────────────────────

/** Search group chats the bot is in by name. Returns up to 50 results. */
export async function searchChats(query: string): Promise<{ chatId: string; name: string }[]> {
  try {
    const url = `${BASE}/im/v1/chats/search?query=${encodeURIComponent(query)}&user_id_type=open_id&page_size=50`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` } });
    const data = await res.json() as {
      code: number; msg: string;
      data?: { items: { chat_id: string; name: string }[] };
    };
    if (data.code !== 0) { console.error(`[feishu-chat] searchChats failed: ${data.code} ${data.msg}`); return []; }
    return (data.data?.items ?? []).map(i => ({ chatId: i.chat_id, name: i.name }));
  } catch (e) {
    console.error("[feishu-chat] searchChats error:", e);
    return [];
  }
}
