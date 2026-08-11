// 注入内容组装（后端集中预算管理）。插件的 before_prompt_build 只做一次
// GET /inject-context，拿到组装好的 markdown 直接注入——预算、分段、缓存
// 全部在这里，插件是纯传输层。

import { buildUserContextMarkdown } from "@/lib/mcp/user-context";
import { buildProductionContextMarkdown } from "@/lib/mcp/production-context";
import { parseSessionIdentity } from "@/lib/mcp/session-identity";
import { readMemory, readRecentRuns } from "./store";

// 各段预算（字符）
const USER_CONTEXT_MAX = 1000;
const PRODUCTION_CONTEXT_MAX = 1000;
const MEMORY_MAX = 4000;
const RECENT_DAYS = 3;
const RECENT_MAX_ENTRIES = 5;
const RECENT_MAX_CHARS = 2000;

// 用户档案 5min 缓存（DB 查询，相对静态；记忆/近期对话每次现读）
const userContextCache = new Map<string, { md: string | null; ts: number }>();
const USER_CONTEXT_TTL_MS = 300_000;
const CACHE_MAX_ENTRIES = 500;

/** 写入时清扫：过期条目删除 + 硬上限兜底（user×production 组合空间在
 * 长进程里无界，不能只靠读时 TTL）。 */
function sweepCache(cache: Map<string, { md: string | null; ts: number }>): void {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.ts > USER_CONTEXT_TTL_MS) cache.delete(k);
  }
  if (cache.size > CACHE_MAX_ENTRIES) {
    for (const k of cache.keys()) {
      if (cache.size <= CACHE_MAX_ENTRIES) break;
      cache.delete(k); // Map 迭代按插入序 → 删最旧
    }
  }
}

async function cachedUserContext(userId: string): Promise<string | null> {
  const hit = userContextCache.get(userId);
  if (hit && Date.now() - hit.ts < USER_CONTEXT_TTL_MS) return hit.md;
  const md = await buildUserContextMarkdown(userId);
  const clipped = md && md.length > USER_CONTEXT_MAX ? `${md.slice(0, USER_CONTEXT_MAX)}…` : md;
  sweepCache(userContextCache);
  userContextCache.set(userId, { md: clipped, ts: Date.now() });
  return clipped;
}

// production 段缓存（user×production 5min——角色/部门/里程碑相对静态）
const productionContextCache = new Map<string, { md: string | null; ts: number }>();

async function cachedProductionContext(userId: string, productionId: string): Promise<string | null> {
  const key = `${userId}:${productionId}`;
  const hit = productionContextCache.get(key);
  if (hit && Date.now() - hit.ts < USER_CONTEXT_TTL_MS) return hit.md;
  const md = await buildProductionContextMarkdown(userId, productionId);
  const clipped = md && md.length > PRODUCTION_CONTEXT_MAX ? `${md.slice(0, PRODUCTION_CONTEXT_MAX)}…` : md;
  sweepCache(productionContextCache);
  productionContextCache.set(key, { md: clipped, ts: Date.now() });
  return clipped;
}

export async function buildInjectContext(userId: string, excludeSessionKey?: string): Promise<string | null> {
  // production 会话：从 sessionKey 解析制作维度，注入"当前制作"段
  // （段内做实时成员资格校验，被移出制作后不再注入）
  const identity = parseSessionIdentity(excludeSessionKey);
  const productionId = identity?.userId === userId ? identity?.productionId : undefined;

  const [userContext, productionContext, memory, recent] = [
    await cachedUserContext(userId),
    productionId ? await cachedProductionContext(userId, productionId) : null,
    readMemory(userId, MEMORY_MAX),
    readRecentRuns(userId, {
      days: RECENT_DAYS,
      maxEntries: RECENT_MAX_ENTRIES,
      maxChars: RECENT_MAX_CHARS,
      excludeSessionKey,
    }),
  ];
  if (!userContext && !productionContext && !memory && !recent) return null;

  const sections: string[] = [];
  if (userContext) sections.push(userContext); // 自带 "## 当前用户" 标题
  if (productionContext) sections.push(productionContext); // 自带 "## 当前制作" 标题
  if (memory) {
    // 防御性降级 MEMORY.md 内部标题（#/## → ###）：蒸馏产物若自带二级
    // 标题会与包裹标题同级，模型会把"长期记忆摘要"读成空标题、把内容
    // 归给后续小节（真机反馈）。蒸馏 prompt 已要求 ### 起步，此处兜底
    // 覆盖历史产物与模型不听话的情况。
    const demoted = memory.replace(/^#{1,2}(?=\s)/gm, "###");
    sections.push(`## 长期记忆摘要\n${demoted}`);
  }
  if (recent) sections.push(`## 近期对话（最近 ${RECENT_DAYS} 天）\n${recent}`);
  return sections.join("\n\n");
}
