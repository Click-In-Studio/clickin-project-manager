// MMP 动态工具的两个稳定权限壳：模型只给 Click-In 的 attachmentId / assetId，
// media_id 永不作为授权凭证。真正提交任务前由通用 runner 再核对在线 registry。

import type { Capability } from "@mmp/client";
import { getAttachmentForSession, getReadyAttachmentForSession, recordAttachmentAccess } from "@/lib/agent/attachment-db";
import { neutralizeInjectionTags } from "@/lib/agent/agent-injection-safety";
import { runMmpCapability } from "@/lib/mmp/capability-runner";
import { resolveReadableAsset } from "./doc-tools";

type CapabilityArgs = {
  capability: Capability;
  tier?: string;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
  runId?: string;
};

export async function runAttachmentCapability(
  userId: string,
  productionId: string | null,
  sessionId: string | null,
  attachmentId: string,
  args: CapabilityArgs,
): Promise<string> {
  if (!sessionId) return "当前运行没有会话上下文，无法处理临时附件。";
  const attachment = await getReadyAttachmentForSession(attachmentId, sessionId, userId);
  if (!attachment) {
    const unavailable = await getAttachmentForSession(attachmentId, sessionId, userId);
    return unavailable ? "该临时附件已释放、过期或正在清理，原件不再可处理。" : "没有找到该临时附件，或它不属于当前会话。";
  }
  const output = await runMmpCapability({
    capability: args.capability,
    file: { fileId: attachment.id, r2Key: attachment.r2Key, mimeType: attachment.mimeType },
    tier: args.tier,
    params: args.params,
    userId,
    productionId,
  }, { signal: args.signal });
  if (args.runId) await recordAttachmentAccess(args.runId, [attachment.id], "mmp_capability");
  return output;
}

export async function runAssetCapability(
  userId: string,
  productionId: string,
  assetId: string,
  args: CapabilityArgs,
): Promise<string> {
  const got = await resolveReadableAsset(userId, productionId, assetId);
  if (typeof got === "string") return neutralizeInjectionTags(got);
  return runMmpCapability({
    capability: args.capability,
    file: {
      fileId: got.file.id,
      r2Key: got.file.r2Key,
      mimeType: got.asset.mimeType ?? "application/octet-stream",
    },
    tier: args.tier,
    params: args.params,
    userId,
    productionId,
  }, { signal: args.signal });
}
