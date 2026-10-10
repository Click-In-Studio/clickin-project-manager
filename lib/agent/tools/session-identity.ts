import crypto from "node:crypto";
import { PRODUCTION_ID_RE } from "./session-identity-parse";

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

