// MMP 动态工具的稳定授权壳。模型只给 Click-In attachmentId / assetId；
// 本层实时核对会话归属或项目预览权，再把短期 GET 句柄交给通用 v3 runner。

import { matchesMediaType, media, type Capability } from "@mmp/client";
import { getAttachmentForSession, getReadyAttachmentForSession, recordAttachmentAccess } from "@/lib/agent/attachment-db";
import { neutralizeInjectionTags } from "@/lib/agent/agent-injection-safety";
import { type CapabilityRunResult, runMmpCapability } from "@/lib/mmp/capability-runner";
import { mmpMediaHandle } from "@/lib/mmp/media-cache";
import { presignedGet } from "@/lib/r2";
import { resolveReadableAsset } from "./doc-tools";

type MediaReference = { attachmentId: string } | { assetId: string };

function reference(value: unknown): MediaReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.attachmentId === "string" && item.attachmentId) return { attachmentId: item.attachmentId };
  if (typeof item.assetId === "string" && item.assetId) return { assetId: item.assetId };
  return null;
}

export async function runCapability(input: {
  userId: string;
  productionId: string | null;
  sessionId: string;
  runId: string;
  toolCallId: string;
  capability: Capability;
  rawArguments: Record<string, unknown>;
  tier?: string;
  signal?: AbortSignal;
  onStatus?: Parameters<typeof runMmpCapability>[0]["onStatus"];
}): Promise<CapabilityRunResult> {
  const touchedAttachments = new Set<string>();
  const result = await runMmpCapability({
    capability: input.capability,
    rawArguments: input.rawArguments,
    tier: input.tier,
    userId: input.userId,
    productionId: input.productionId,
    sessionId: input.sessionId,
    runId: input.runId,
    toolCallId: input.toolCallId,
    onStatus: input.onStatus,
    resolveMedia: async (fieldName, raw, capability) => {
      const field = capability.input.fields.find((item) => item.name === fieldName && item.kind === "media");
      if (!field || field.kind !== "media") throw new Error(`未知 media 字段 ${fieldName}`);
      const values = Array.isArray(raw) ? raw : [raw];
      if (values.length < field.cardinality.min || values.length > field.cardinality.max) {
        throw new Error(`${fieldName} 需要 ${field.cardinality.min}–${field.cardinality.max} 个媒体输入`);
      }
      const handles = [];
      const cacheKeys: string[] = [];
      for (const value of values) {
        const ref = reference(value);
        if (!ref) throw new Error(`${fieldName} 只接受 {attachmentId} 或 {assetId}`);
        if ("attachmentId" in ref) {
          const attachment = await getReadyAttachmentForSession(ref.attachmentId, input.sessionId, input.userId);
          if (!attachment) {
            const unavailable = await getAttachmentForSession(ref.attachmentId, input.sessionId, input.userId);
            throw new Error(unavailable ? "该临时附件已释放、过期或正在清理" : "附件不存在或不属于当前会话");
          }
          if (!field.accepts.some((pattern) => matchesMediaType(pattern, attachment.mimeType))) {
            throw new Error(`${fieldName} 不接受 ${attachment.mimeType}`);
          }
          handles.push(mmpMediaHandle(attachment.id, media.get(presignedGet(attachment.r2Key, 15 * 60), undefined, attachment.mimeType)));
          cacheKeys.push(attachment.id);
          touchedAttachments.add(attachment.id);
        } else {
          if (!input.productionId) throw new Error("个人会话不能引用项目资产");
          const got = await resolveReadableAsset(input.userId, input.productionId, ref.assetId);
          if (typeof got === "string") throw new Error(neutralizeInjectionTags(got));
          const mimeType = got.asset.mimeType ?? "application/octet-stream";
          if (!field.accepts.some((pattern) => matchesMediaType(pattern, mimeType))) throw new Error(`${fieldName} 不接受 ${mimeType}`);
          handles.push(mmpMediaHandle(got.file.id, media.get(presignedGet(got.file.r2Key, 15 * 60), undefined, mimeType)));
          cacheKeys.push(got.file.id);
        }
      }
      return { value: field.cardinality.max === 1 ? handles[0] : handles, cacheKeys };
    },
  }, { signal: input.signal });
  if (touchedAttachments.size) await recordAttachmentAccess(input.runId, [...touchedAttachments], "mmp_capability");
  return result;
}
