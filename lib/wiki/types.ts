import type { Mention } from "../event-db";

// ─── wiki 文档域共享类型（#420 后 wiki 回归纯内容对象）───────────────────────
// 树位置（parent/sort）与权限位（is_public/listable）活在 node 壳上
// （lib/node/db.ts NodeRecord），本类型不再携带。

export type WikiDoc = {
  id: string;
  productionId: string;
  title: string | null;
  body: string;
  mentions: Mention[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WikiRow = {
  id: string; production_id: string; title: string | null; body: string;
  mentions: Mention[]; created_by: string | null;
  created_at: Date; updated_at: Date;
};

export function rowToWiki(r: WikiRow): WikiDoc {
  return {
    id: r.id, productionId: r.production_id, title: r.title, body: r.body,
    mentions: r.mentions ?? [], createdBy: r.created_by,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}
