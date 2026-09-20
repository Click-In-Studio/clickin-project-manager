/**
 * 本子（script_view 表）数据层——#336 B2。
 *
 * 一个演出 N 个本子 + 一个主本（production.master_view_id），版式（pageLayout /
 * textLayoutMode）只存在 script_view 行上。本阶段只有主本一条：建项即带、写路径
 * 自愈补建；多本、权限门、内容过滤在 #339。scriptViewLayout 是「行 → 版式」的唯一
 * 解释口，剧本装配与页码测算都经它。
 */
import { getPool } from "../pg";
import type { Pool, PoolClient } from "pg";
import { DEFAULT_SCRIPT_CONFIG, type PageLayout, type ScriptTextLayoutMode } from "./script-types";

export const PAGE_LAYOUTS: PageLayout[] = ["a4", "letter", "a3-2col", "tablet-2col"];

function newScriptViewId(): string {
  return `sv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isPageLayout(value: unknown): value is PageLayout {
  return typeof value === "string" && (PAGE_LAYOUTS as string[]).includes(value);
}

export function scriptViewLayout(row: { page_layout: string | null; text_layout_mode: string | null } | undefined): {
  pageLayout: PageLayout; textLayoutMode: ScriptTextLayoutMode;
} {
  return {
    pageLayout: isPageLayout(row?.page_layout) ? row!.page_layout : DEFAULT_SCRIPT_CONFIG.pageLayout,
    textLayoutMode: row?.text_layout_mode === "compact" ? "compact" : DEFAULT_SCRIPT_CONFIG.textLayoutMode,
  };
}

/**
 * 给演出建主本（createProduction 事务内调用）。版式取缺省——建项目时还没人选过版式。
 */
export async function createMasterScriptView(productionId: string, client: PoolClient | Pool): Promise<string> {
  const id = newScriptViewId();
  await client.query(
    "INSERT INTO script_view (id, production_id, name) VALUES ($1, $2, '标准本')",
    [id, productionId],
  );
  await client.query("UPDATE production SET master_view_id = $1 WHERE id = $2", [id, productionId]);
  return id;
}

export async function getMasterScriptViewId(productionId: string): Promise<string | null> {
  const res = await getPool().query<{ master_view_id: string | null }>(
    "SELECT master_view_id FROM production WHERE id = $1", [productionId],
  );
  return res.rows[0]?.master_view_id ?? null;
}

/** 写路径的自愈：主本缺席（迁移前建的演出且迁移未跑）就补一条，别让版式保存静默丢失。 */
export async function ensureMasterScriptView(productionId: string): Promise<string> {
  const existing = await getMasterScriptViewId(productionId);
  if (existing) return existing;
  return createMasterScriptView(productionId, getPool());
}
