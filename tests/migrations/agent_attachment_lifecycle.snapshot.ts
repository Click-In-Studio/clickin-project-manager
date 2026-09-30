import os from "node:os";
import path from "node:path";
import type { MigrationHook } from "../_support/global-setup";

export const SNAPSHOT_PATH = path.join(os.tmpdir(), "agent-attachment-lifecycle-migration-snapshot.json");

export type AgentAttachmentLifecycleSnapshot = {
  sessionId: string;
  userId: string;
  attachments: Array<{ id: string; r2Key: string; fileName: string; fileSize: number; status: "pending" | "ready" }>;
};

export const createPreMigrationData: MigrationHook<AgentAttachmentLifecycleSnapshot>["createPreMigrationData"] =
  async ({ pool, faker, testOwner }) => {
    const sessionId = `clickin:chat:${testOwner}:${faker.string.alphanumeric(12).toLowerCase()}`;
    await pool.query(`INSERT INTO agent_session (id, user_id) VALUES ($1, $2)`, [sessionId, testOwner]);
    const attachments = [
      {
        id: `aat_mig_${faker.string.alphanumeric(10).toLowerCase()}`,
        r2Key: `agent-attachments/migration-${faker.string.alphanumeric(10).toLowerCase()}/ready.txt`,
        fileName: "迁移前已就绪.txt", fileSize: 1234, status: "ready" as const,
      },
      {
        id: `aat_mig_${faker.string.alphanumeric(10).toLowerCase()}`,
        r2Key: `agent-attachments/migration-${faker.string.alphanumeric(10).toLowerCase()}/pending.txt`,
        fileName: "迁移前上传中.txt", fileSize: 5678, status: "pending" as const,
      },
    ];
    for (const item of attachments) await pool.query(
      `INSERT INTO agent_session_attachment
         (id, session_id, r2_key, file_name, mime_type, file_size, status, ready_at)
       VALUES ($1,$2,$3,$4,'text/plain',$5,$6,CASE WHEN $6 = 'ready' THEN now() ELSE NULL END)`,
      [item.id, sessionId, item.r2Key, item.fileName, item.fileSize, item.status],
    );
    return { sessionId, userId: testOwner, attachments };
  };

export const cleanup: MigrationHook<AgentAttachmentLifecycleSnapshot>["cleanup"] = async (pool, snapshot) => {
  await pool.query(`DELETE FROM agent_attachment_object WHERE session_id = $1`, [snapshot.sessionId]);
  await pool.query(`DELETE FROM agent_session WHERE id = $1`, [snapshot.sessionId]);
};
