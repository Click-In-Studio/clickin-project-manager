import crypto from "node:crypto";

// webchat sessionKey 的身份解析（后端侧；插件内保持同构正则）。
// 两种格式：
//   个人会话        clickin:chat:<userId>:<sessionUuid>
//   production 会话  clickin:chat:<userId>:<productionId>:<sessionUuid>
// 均可带 gateway 回显的 agent:<agentId>: 前缀，以及 :heartbeat 等子键后缀。
//
// 判别依据：production id 是后台 uid() 生成的短字母数字串（无连字符，
// ≤32 位），不可能与 36 位带连字符的 UUID 混淆；末段恒为会话 UUID。

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_KEY_RE = new RegExp(
  `clickin:chat:(${UUID}):(?:([a-z0-9]{1,32}):)?(${UUID})(?::|$)`,
  "i",
);

export const PRODUCTION_ID_RE = /^[a-z0-9]{1,32}$/i;

const SESSION_NAMESPACE = "clickin:chat:";

/** 个人会话：clickin:chat:<userId>:<uuid>
 *  production 会话：clickin:chat:<userId>:<productionId>:<uuid>
 * productionId 是后台 uid() 短字母数字串（无连字符，与末段 UUID 可判别）。
 * 成员资格校验在签发路由做——这里只负责格式（非法 id 直接抛，防 key 注入）。 */
export function createNewSessionKey(userId: string, productionId?: string): string {
  if (productionId !== undefined && !PRODUCTION_ID_RE.test(productionId)) {
    throw new Error(`invalid productionId for session key: ${productionId}`);
  }
  const mid = productionId ? `${productionId}:` : "";
  return `${SESSION_NAMESPACE}${userId}:${mid}${crypto.randomUUID()}`;
}

/** 所有权判定：sessionKey 是否属于该用户（网关时代的 agent:<id>: 回显前缀仍容忍）。 */
export function sessionKeyOwnedBy(sessionKey: string, userId: string): boolean {
  const bare = sessionKey.replace(/^agent:[^:]+:/, "");
  return bare.startsWith(`${SESSION_NAMESPACE}${userId}:`);
}

/** production 会话 → productionId，个人会话/非法 key → null。 */
export function productionIdOfSessionKey(sessionKey: string): string | null {
  const bare = sessionKey.replace(/^agent:[^:]+:/, "");
  if (!bare.startsWith(SESSION_NAMESPACE)) return null;
  const parts = bare.slice(SESSION_NAMESPACE.length).split(":");
  return parts.length === 3 && PRODUCTION_ID_RE.test(parts[1]) ? parts[1] : null;
}

export function parseSessionIdentity(
  sessionKey: string | undefined,
): { userId: string; productionId?: string } | null {
  if (!sessionKey) return null;
  const m = SESSION_KEY_RE.exec(sessionKey);
  if (!m) return null;
  return { userId: m[1].toLowerCase(), productionId: m[2]?.toLowerCase() };
}
