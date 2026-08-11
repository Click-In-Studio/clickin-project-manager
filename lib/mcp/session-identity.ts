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

export function parseSessionIdentity(
  sessionKey: string | undefined,
): { userId: string; productionId?: string } | null {
  if (!sessionKey) return null;
  const m = SESSION_KEY_RE.exec(sessionKey);
  if (!m) return null;
  return { userId: m[1].toLowerCase(), productionId: m[2]?.toLowerCase() };
}
