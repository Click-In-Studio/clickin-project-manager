import { getPool } from "@/lib/pg";
import { newObservationId } from "./ids";

export type ObservationKind = "model_request" | "tool_retrieval" | "memory_retrieval" | "compaction_check";

/** 观测只存调用方明确构造的数值/标识/原因，不接收 prompt、正文或异常消息。 */
export async function startObservation(kind: ObservationKind, runId: string | null, data: object, userId: string | null = null): Promise<string | null> {
  const id = newObservationId();
  try {
    await getPool().query(
      "INSERT INTO agent_observation(id,run_id,user_id,kind,data) VALUES($1,$2,$3,$4,$5::jsonb)",
      [id, runId, userId, kind, JSON.stringify(data)],
    );
    return id;
  } catch {
    console.error("[agent-observation] 观测写入失败", kind);
    return null;
  }
}

export async function finishObservation(id: string | null, elapsedMs: number, data: object): Promise<void> {
  if (!id) return;
  try {
    await getPool().query(
      "UPDATE agent_observation SET ended_at=now(),elapsed_ms=$2,data=data || $3::jsonb WHERE id=$1",
      [id, elapsedMs, JSON.stringify(data)],
    );
  } catch {
    console.error("[agent-observation] 观测收尾失败");
  }
}
