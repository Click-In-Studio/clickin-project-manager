import { chat } from "@/lib/agent/llm-chat";
import {
  addMemoryRelations,
  commitGroupSummary,
  evictMemoryCache,
  listMemoryScopes,
  readGroupPage,
  type RelationInput,
} from "./memory-group-db";
import { readOrganizeCandidates, markOrganized } from "./memory-organize-db";
import { cachePressure, indexMemoryEntries } from "./memory-search-db";
import { ORGANIZE_RULES, SUMMARY_RULES } from "./memory-prompt";
import { readSummaryProgress, saveSummaryProgress } from "./memory-summary-db";
import { enqueuePendingSummaries } from "./memory-jobs";
import { MEMORY_CACHE_TRIGGER } from "./memory-types";

export function parseRelations(raw: string): RelationInput[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("整理结果需要关系数组");
  return value.map((v: unknown) => {
    if (!v || typeof v !== "object") throw new Error("关系格式错误");
    const r = v as Record<string, unknown>;
    if (
      typeof r.leftId !== "string" ||
      typeof r.rightId !== "string" ||
      r.leftId === r.rightId ||
      !["duplicate", "conflict"].includes(String(r.kind)) ||
      typeof r.reason !== "string" ||
      !r.reason.trim() ||
      r.reason.length > 500
    )
      throw new Error("关系格式错误");
    return {
      leftId: r.leftId,
      rightId: r.rightId,
      kind: r.kind as RelationInput["kind"],
      reason: r.reason,
    };
  });
}
export function parseSummary(raw: string): string {
  const value: unknown = JSON.parse(raw);
  const summary =
    value && typeof value === "object"
      ? (value as Record<string, unknown>).summary
      : null;
  if (typeof summary !== "string" || !summary.trim() || summary.length > 4000)
    throw new Error("摘要格式错误");
  return summary;
}
export async function summarizeMaterials(
  materials: unknown[],
): Promise<string> {
  const result = await chat(
    [
      { role: "system", content: SUMMARY_RULES },
      { role: "user", content: JSON.stringify(materials) },
    ],
    {
      purpose: "memory-organize-summary",
      maxTokens: 6000,
      parse: parseSummary,
    },
  );
  return result.value;
}
/** 每次调用有界；超大组分页摘要并逐次合并，提交时验证整个组修订。 */
export async function summarizeMemoryGroup(
  userId: string,
  productionId: string | null,
  groupId: string,
  revision: number,
): Promise<boolean> {
  const saved = await readSummaryProgress(userId, productionId, groupId, revision);
  if (saved.complete) return true;
  let progress = saved.progress;
  let offset = progress?.offset ?? 0;
  let relationAfter = progress?.relationAfter ?? null;
  let summary: string | null = progress?.summary ?? null;
  for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
    const page = await readGroupPage(
      userId,
      productionId,
      groupId,
      revision,
      offset,
      relationAfter,
    );
    const materials = [
      ...(summary
        ? [{ previousSummary: summary, previousCoveredEntries: relationAfter ? Math.min(offset + 5, page.total) : offset }]
        : []),
      {
        entries: page.group.entries,
        relations: page.group.relations,
        coverage: {
          offset,
          currentEntries: page.group.entries.length,
          coveredEntries: offset + page.group.entries.length,
          totalEntries: page.total,
          complete: page.nextOffset === null,
          ...(relationAfter || page.nextRelationAfter ? { relationAfter, nextRelationAfter: page.nextRelationAfter } : {}),
        },
      },
    ];
    summary = await summarizeMaterials(materials);
    if (page.nextOffset === null)
      return commitGroupSummary(
        userId,
        productionId,
        groupId,
        revision,
        summary,
      );
    const next = { offset: page.nextOffset, relationAfter: page.nextRelationAfter, summary };
    if (!await saveSummaryProgress(userId, productionId, groupId, revision, progress, next)) return false;
    progress = next;
    offset = next.offset;
    relationAfter = next.relationAfter;
  }
  return false;
}
export async function organizeMemoryScope(
  userId: string,
  productionId: string | null,
): Promise<{ status: "organized" | "empty"; relations: number }> {
  const snapshot = await readOrganizeCandidates(userId, productionId);
  if (!snapshot.entries.length) {
    await enqueuePendingSummaries(userId, productionId);
    return { status: "empty", relations: 0 };
  }
  const generated = await chat(
    [
      { role: "system", content: ORGANIZE_RULES },
      { role: "user", content: JSON.stringify(snapshot.entries) },
    ],
    { purpose: "memory-organize", maxTokens: 6000, parse: parseRelations },
  );
  await addMemoryRelations(
    userId,
    productionId,
    generated.value,
    Object.fromEntries(snapshot.entries.map((e) => [e.id, e.revision])),
  );
  await markOrganized(
    userId,
    productionId,
    snapshot.entries.filter((e) => snapshot.checked.includes(e.id)),
  );
  await indexMemoryEntries(userId, productionId);
  await enqueuePendingSummaries(userId, productionId);
  await evictMemoryCache(userId, productionId);
  return { status: "organized", relations: generated.value.length };
}
export async function maintainMemoryCache(
  userId: string,
  productionId: string | null,
): Promise<void> {
  if ((await cachePressure(userId, productionId)) < MEMORY_CACHE_TRIGGER) {
    await indexMemoryEntries(userId, productionId);
    await enqueuePendingSummaries(userId, productionId);
    return;
  }
  try {
    await organizeMemoryScope(userId, productionId);
  } finally {
    await evictMemoryCache(userId, productionId);
  }
}
export async function organizeAllMemories() {
  const results = [];
  for (const scope of await listMemoryScopes()) {
    try {
      results.push({
        ...scope,
        ...(await organizeMemoryScope(scope.userId, scope.productionId)),
      });
    } catch (error) {
      results.push({
        ...scope,
        status: "error",
        error: error instanceof Error ? error.message : "整理失败",
      });
    }
  }
  return results;
}
