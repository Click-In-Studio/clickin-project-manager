// 历史归档复用现有记忆索引表；文件只由一次性迁移脚本读取。
export type RunRecord = {
  ts: string; sessionKey?: string; runId?: string | null; productionId?: string | null;
  success?: boolean; error?: string | null; durationMs?: number | null;
  lastUser?: string | null; lastAssistant?: string | null;
};
export async function appendRunRecord(userId: string, record: RunRecord): Promise<void> {
  const { indexEpisodicRun } = await import("./index-db");
  await indexEpisodicRun(userId, record);
}
