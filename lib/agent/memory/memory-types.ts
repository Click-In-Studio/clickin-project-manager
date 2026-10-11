// 客户端与服务端共用的记忆契约，不依赖 Node 或数据库。
export type MemorySource = "dream" | "active";
export type MemoryEntry = {
  id: string;
  body: string;
  source: MemorySource;
  userEdited: boolean;
  revision: number;
  updatedAt: string;
  // 这是服务端记录的整理输入范围，不是该结论的逐条证据。
  inputCount: number;
};
export type MemoryScopeView = {
  productionId: string | null;
  revision: number;
  historyCutoff: string | null;
  entries: MemoryEntry[];
};
export const MEMORY_ENTRY_MAX = 1000;
export const MEMORY_SCOPE_MAX = 12_000;
