import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { createNewSessionKey } from "@/lib/agent/tools/session-identity";
import {
  createPendingAttachment,
  getAttachmentUsage,
  markAttachmentReady,
  recordAttachmentAccess,
  restoreReleasedAttachment,
} from "@/lib/agent/attachment-db";
import { readSessionAttachment, releaseSessionAttachment, saveSessionAttachmentAsAsset } from "@/lib/agent/tools/attachment-tools";
import { buildAttachmentLifecycleBlock } from "@/lib/agent/attachment-lifecycle";
import { deleteSessionRows } from "@/lib/agent/runtime/service";
import { DEFS } from "@/lib/agent/runtime/tools";
import { cleanupProduction, makeProduction, shortId } from "../_support/factories";

let userId: string;
let prodId: string;
const sessionIds: string[] = [];

beforeAll(async () => {
  ({ userId } = await upsertFeishuUser(`lifecycle-open-${shortId()}`, `附件生命周期-${shortId()}`, null, false));
  ({ prodId } = await makeProduction(userId));
});

afterAll(async () => {
  await getPool().query(`DELETE FROM agent_attachment_object WHERE session_id = ANY($1::text[])`, [sessionIds]).catch(() => {});
  for (const id of sessionIds) await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [id]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

async function readyAttachment(productionId?: string) {
  const sessionId = createNewSessionKey(userId, productionId);
  sessionIds.push(sessionId);
  const attachment = await createPendingAttachment({
    sessionId, userId, fileName: "参考资料.txt", mimeType: "text/plain", fileSize: 12,
  });
  return { sessionId, attachment: (await markAttachmentReady(attachment.id, sessionId, userId, 12))! };
}

describe("附件生命周期（#772）", () => {
  it("只有本轮成功处理过的附件可免确认释放，并可在宽限期恢复", async () => {
    const { sessionId, attachment } = await readyAttachment();
    const runId = `ar_lifecycle_${shortId()}`;
    await getPool().query(`INSERT INTO agent_run (id, session_id) VALUES ($1, $2)`, [runId, sessionId]);
    await expect(releaseSessionAttachment({ userId, sessionId, runId, attachmentId: attachment.id }))
      .rejects.toMatchObject({ status: 409 });
    await recordAttachmentAccess(runId, [attachment.id], "read");
    expect(await releaseSessionAttachment({ userId, sessionId, runId, attachmentId: attachment.id })).toContain("24 小时");
    const released = await getPool().query<{ status: string; release_until: Date | null }>(
      `SELECT status, release_until FROM agent_session_attachment WHERE id = $1`, [attachment.id],
    );
    expect(released.rows[0].status).toBe("released");
    expect(released.rows[0].release_until).not.toBeNull();
    expect((await restoreReleasedAttachment(attachment.id, sessionId, userId))?.status).toBe("ready");
  });

  it("删除 session 前先把对象转入可靠回收账，级联后仍保留重试线索", async () => {
    const { sessionId, attachment } = await readyAttachment();
    await deleteSessionRows(sessionId);
    const row = await getPool().query<{ attachment_id: string | null; status: string; r2_key: string }>(
      `SELECT attachment_id, status, r2_key FROM agent_attachment_object WHERE session_id = $1`, [sessionId],
    );
    expect(row.rows).toEqual([{ attachment_id: null, status: "delete_pending", r2_key: attachment.r2Key }]);
  });

  it("读取工具对已安排清理的附件返回明确状态", async () => {
    const { sessionId, attachment } = await readyAttachment();
    await getPool().query(`UPDATE agent_session_attachment SET status = 'deleting' WHERE id = $1`, [attachment.id]);
    expect(await readSessionAttachment(userId, null, sessionId, { attachmentId: attachment.id }))
      .toContain("已过期或正在清理");
  });

  it("存为资产复用同一 R2 key、退出临时额度且保持幂等", async () => {
    const { sessionId, attachment } = await readyAttachment(prodId);
    const first = await saveSessionAttachmentAsAsset({ userId, productionId: prodId, sessionId, attachmentId: attachment.id });
    const assetId = /资产 id: ([a-z0-9_]+)/.exec(first)?.[1];
    expect(assetId).toBeTruthy();
    const stored = await getPool().query<{ status: string; promoted_asset_id: string; object_status: string; r2_key: string }>(
      `SELECT a.status, a.promoted_asset_id, o.status AS object_status, af.r2_key
       FROM agent_session_attachment a
       JOIN agent_attachment_object o ON o.attachment_id = a.id AND o.kind = 'original'
       JOIN asset_file af ON af.asset_id = a.promoted_asset_id
       WHERE a.id = $1`, [attachment.id],
    );
    expect(stored.rows[0]).toEqual({
      status: "promoted", promoted_asset_id: assetId, object_status: "transferred", r2_key: attachment.r2Key,
    });
    expect((await getAttachmentUsage(userId, sessionId)).session.bytes).toBe(0);
    expect(await saveSessionAttachmentAsAsset({ userId, productionId: prodId, sessionId, attachmentId: attachment.id }))
      .toContain(`资产 id: ${assetId}`);
  });

  it("生命周期块是临时注入：个人会话只提示释放，制作会话有资格时提示资产化", async () => {
    const personal = await readyAttachment();
    const personalBlock = await buildAttachmentLifecycleBlock({ sessionId: personal.sessionId, userId, productionId: null });
    expect(personalBlock.text).toContain("<clickin-attachment-lifecycle>");
    expect(personalBlock.toolNames).toEqual(["my.attachment_release"]);
    const production = await readyAttachment(prodId);
    const productionBlock = await buildAttachmentLifecycleBlock({ sessionId: production.sessionId, userId, productionId: prodId });
    expect(productionBlock.toolNames).toContain("production.attachment_save_as_asset");
  });

  it("注册表只给释放工具可逆免确认，资产化仍需确认且两者都禁止无人值守", () => {
    const release = DEFS.find((item) => item.mcpName === "my.attachment_release");
    const save = DEFS.find((item) => item.mcpName === "production.attachment_save_as_asset");
    expect(release).toMatchObject({ readOnly: false, reversibleNoConfirm: true });
    expect(release?.unattended).not.toBe("allow");
    expect(save).toMatchObject({ readOnly: false, needsProduction: true });
    expect(save?.reversibleNoConfirm).not.toBe(true);
    expect(save?.unattended).not.toBe("allow");
  });
});
