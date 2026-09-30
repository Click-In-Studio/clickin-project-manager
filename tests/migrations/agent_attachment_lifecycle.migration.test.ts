import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import {
  SNAPSHOT_PATH,
  type AgentAttachmentLifecycleSnapshot,
} from "./agent_attachment_lifecycle.snapshot";

let snapshot: AgentAttachmentLifecycleSnapshot | null = null;
try { snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as AgentAttachmentLifecycleSnapshot; }
catch { snapshot = null; }

describe("schema verification", () => {
  it("附件生命周期列、对象账本和运行访问证据表已建立", async () => {
    const columns = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'agent_session_attachment'
         AND column_name = ANY($1::text[])`,
      [["expires_at", "absolute_expires_at", "last_referenced_at", "release_until", "deleted_at", "promoted_asset_id"]],
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual(
      ["absolute_expires_at", "deleted_at", "expires_at", "last_referenced_at", "promoted_asset_id", "release_until"],
    );
    const tables = await getPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`, [["agent_attachment_object", "agent_run_attachment_access"]],
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual(["agent_attachment_object", "agent_run_attachment_access"]);
  });
});

describe("integrity verification", () => {
  it("每个存量附件恰有一条原件回收账", async () => {
    const rows = await getPool().query<{ attachment_id: string; count: string }>(
      `SELECT attachment_id, count(*)::text AS count FROM agent_attachment_object
       WHERE kind = 'original' AND attachment_id IS NOT NULL GROUP BY attachment_id HAVING count(*) <> 1`,
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("活跃对象账本不引用不存在的附件", async () => {
    const rows = await getPool().query(
      `SELECT o.id FROM agent_attachment_object o LEFT JOIN agent_session_attachment a ON a.id = o.attachment_id
       WHERE o.attachment_id IS NOT NULL AND a.id IS NULL LIMIT 1`,
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe("invariance verification", () => {
  it.skipIf(!snapshot)("存量附件元数据原样保留并按状态获得正确 TTL", async () => {
    const rows = await getPool().query<{
      id: string; r2_key: string; file_name: string; file_size: string; status: string;
      ttl_hours: string; object_status: string; object_bytes: string;
    }>(
      `SELECT a.id, a.r2_key, a.file_name, a.file_size, a.status,
              round(extract(epoch FROM (a.expires_at - a.created_at)) / 3600)::text AS ttl_hours,
              o.status AS object_status, o.byte_size AS object_bytes
       FROM agent_session_attachment a JOIN agent_attachment_object o ON o.attachment_id = a.id AND o.kind = 'original'
       WHERE a.id = ANY($1::text[]) ORDER BY a.id`, [snapshot!.attachments.map((item) => item.id)],
    );
    expect(rows.rows.map((row) => ({
      id: row.id, r2Key: row.r2_key, fileName: row.file_name, fileSize: Number(row.file_size), status: row.status,
      ttlHours: Number(row.ttl_hours), objectStatus: row.object_status, objectBytes: Number(row.object_bytes),
    }))).toEqual(snapshot!.attachments.map((item) => ({
      ...item,
      ttlHours: item.status === "pending" ? 2 : 24,
      objectStatus: item.status === "pending" ? "reserved" : "present",
      objectBytes: item.fileSize,
    })).sort((a, b) => a.id.localeCompare(b.id)));
  });
});
