import type { Mention } from "../event-db";

// ─── wiki 文档域共享类型（自 wiki-db.ts 拆出，PR-1 纯移动）────────────────────

export type WikiDoc = {
  id: string;
  productionId: string;
  title: string | null;
  body: string;
  mentions: Mention[];
  createdBy: string | null;
  parentId: string | null;
  sortKey: string | null;
  isPublic: boolean;
  /** 可枚举性（#357 枚举面，与 isPublic 的内容面正交）：是否对能枚举父节点者出现在目录树 */
  listable: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WikiListEntry = Omit<WikiDoc, "body" | "mentions"> & {
  tags: string[];
  /** 系统锚点目录（默认树的根/event 目录）：可移动可改名，不可删除 */
  isAnchor: boolean;
};

export type WikiRow = {
  id: string; production_id: string; title: string | null; body: string;
  mentions: Mention[]; created_by: string | null; parent_id: string | null;
  sort_key: string | null; is_public: boolean; listable: boolean;
  created_at: Date; updated_at: Date;
};

export function rowToWiki(r: WikiRow): WikiDoc {
  return {
    id: r.id, productionId: r.production_id, title: r.title, body: r.body,
    mentions: r.mentions ?? [], createdBy: r.created_by, parentId: r.parent_id,
    sortKey: r.sort_key, isPublic: r.is_public, listable: r.listable,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}
