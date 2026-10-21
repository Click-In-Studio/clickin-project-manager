// 客户端与服务端共用，不依赖 Node 或数据库。
export type MemorySource = "active";
export type MemoryEntry = {
  id: string;
  body: string;
  brief: string;
  groupId: string | null;
  source: MemorySource;
  userEdited: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
export type MemoryRelation = {
  id: string;
  leftId: string;
  rightId: string;
  kind: "duplicate" | "conflict";
  reason: string;
  createdAt: string;
};
export type MemoryGroup = {
  id: string;
  revision: number;
  memberCount: number;
  inCache: boolean;
  lastTouchedAt: string;
  summary: string | null;
  summaryPending: boolean;
  entries: MemoryEntry[];
  relations: MemoryRelation[];
};
export type MemoryScopeView = {
  productionId: string | null;
  revision: number;
  historyCutoff: string | null;
  entries: MemoryEntry[];
  deletedEntries: MemoryEntry[];
};
export const MEMORY_ENTRY_MAX = 1000;
export const MEMORY_BRIEF_MAX = 300;
export const MEMORY_CACHE_SAFE = 24;
export const MEMORY_CACHE_TRIGGER = 36;
export const MEMORY_GROUP_BRIEF_MAX = 2400;
export const MEMORY_INJECTION_MAX = 128000;
