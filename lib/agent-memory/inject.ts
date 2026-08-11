// 注入内容组装（后端集中预算管理）。插件的 before_prompt_build 只做一次
// GET /inject-context，拿到组装好的 markdown 直接注入——预算、分段、缓存
// 全部在这里，插件是纯传输层。

import { buildUserContextMarkdown } from "@/lib/mcp/user-context";
import { readMemory, readRecentRuns } from "./store";

// 各段预算（字符）——production 段将在 Phase A-2 加入
const USER_CONTEXT_MAX = 1000;
const MEMORY_MAX = 4000;
const RECENT_DAYS = 3;
const RECENT_MAX_ENTRIES = 5;
const RECENT_MAX_CHARS = 2000;

// 用户档案 5min 缓存（DB 查询，相对静态；记忆/近期对话每次现读）
const userContextCache = new Map<string, { md: string | null; ts: number }>();
const USER_CONTEXT_TTL_MS = 300_000;

async function cachedUserContext(userId: string): Promise<string | null> {
  const hit = userContextCache.get(userId);
  if (hit && Date.now() - hit.ts < USER_CONTEXT_TTL_MS) return hit.md;
  const md = await buildUserContextMarkdown(userId);
  const clipped = md && md.length > USER_CONTEXT_MAX ? `${md.slice(0, USER_CONTEXT_MAX)}…` : md;
  userContextCache.set(userId, { md: clipped, ts: Date.now() });
  return clipped;
}

export async function buildInjectContext(userId: string, excludeSessionKey?: string): Promise<string | null> {
  const [userContext, memory, recent] = [
    await cachedUserContext(userId),
    readMemory(userId, MEMORY_MAX),
    readRecentRuns(userId, {
      days: RECENT_DAYS,
      maxEntries: RECENT_MAX_ENTRIES,
      maxChars: RECENT_MAX_CHARS,
      excludeSessionKey,
    }),
  ];
  if (!userContext && !memory && !recent) return null;

  const sections: string[] = [];
  if (userContext) sections.push(userContext); // 自带 "## 当前用户" 标题
  if (memory) sections.push(`## 长期记忆摘要\n${memory}`);
  if (recent) sections.push(`## 近期对话（最近 ${RECENT_DAYS} 天）\n${recent}`);
  return sections.join("\n\n");
}
