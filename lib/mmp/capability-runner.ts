// MMP v3 capability 的统一执行器。字段名、输入 schema 与输出均来自在线 capability；
// 本层不按 capability id 分流，也不把 R2 key、签名 URL 或 media_id 暴露给模型。

import { createHash } from "node:crypto";
import { MmpError, type Capability, type MediaHandle, type MmpClient } from "@mmp/client";
import {
  AGENT_ATTACHMENT_MAX_BYTES,
  createPendingAttachment,
  markAttachmentReady,
  scheduleAttachmentDeletion,
  type AgentAttachment,
} from "@/lib/agent/attachment-db";
import { neutralizeInjectionTags } from "@/lib/agent/agent-injection-safety";
import { getR2Object, headR2Object, presignedPut } from "@/lib/r2";
import { admittedMmpRun } from "./admitted-run";
import { getMmpClient } from "./client";
import { rememberMmpMediaId } from "./media-cache";
import { recordMmpUsage } from "./usage-db";
import { billableMmpCompute, legacyComputeMs } from "./usage";

const RUN_TIMEOUT_MS = 10 * 60_000;
const POLL_WAIT_SEC = 30;
export const MMP_RESULT_MAX_CHARS = 24_000;

export type MmpRunStatus = { status: "queued" | "running"; etaSec?: number; queuePosition?: number };
export type CapabilityRunResult = {
  text: string;
  attachments: AgentAttachment[];
  media: Array<{
    type: "image";
    mimeType: string;
    attachmentId: string;
    fileName: string;
    source: { kind: "attachment"; sha256: string };
  }>;
};
export type CapabilityMediaResolver = (
  fieldName: string,
  raw: unknown,
  capability: Capability,
) => Promise<{ value: MediaHandle | MediaHandle[]; cacheKeys: string[] }>;

function clipped(text: string): string {
  const safe = neutralizeInjectionTags(text.replace(/\u0000/g, "�"));
  return safe.length <= MMP_RESULT_MAX_CHARS
    ? safe
    : `${safe.slice(0, MMP_RESULT_MAX_CHARS)}\n…（MMP 结果超过 ${MMP_RESULT_MAX_CHARS} 字符，已截断）`;
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jsonOutputs(done: Awaited<ReturnType<MmpClient["run"]>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(done.outputs).flatMap(([name, output]) =>
    !Array.isArray(output) && output.kind === "json" ? [[name, output.value]] : [],
  ));
}

function matchingDimensions(metadata: Record<string, unknown>, actual: { width: number; height: number }): boolean {
  return Object.values(metadata).some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return item.width === actual.width && item.height === actual.height;
  });
}

function renderTextOutputs(capability: Capability, done: Awaited<ReturnType<MmpClient["run"]>>, attachments: AgentAttachment[]): string {
  const source = `来源：${done.source.engine}@${done.source.engine_version}，tier=${done.source.tier}`
    + `${done.source.degraded ? `，已降级（${done.source.degraded_reason ?? "未说明"}）` : ""}`
    + `${done.cached ? "，缓存命中" : ""}`;
  const lines = [source];
  if (done.agent_context?.text) lines.push(done.agent_context.text);
  for (const field of capability.output.fields) {
    const output = done.outputs[field.name];
    if (!output || Array.isArray(output)) continue;
    if (output.kind === "text") lines.push(`${field.name}：${output.text}`);
    if (output.kind === "json") lines.push(`${field.name}：${JSON.stringify(output.value)}`);
  }
  for (const attachment of attachments) {
    lines.push(`生成附件：attachmentId=${attachment.id}；fileName=${attachment.fileName}；mimeType=${attachment.mimeType}；bytes=${attachment.fileSize}`
      + `${attachment.sourceMetadata ? `；metadata=${JSON.stringify(attachment.sourceMetadata)}` : ""}`);
  }
  return clipped(lines.join("\n"));
}

function mediaOutputFields(capability: Capability) {
  return capability.output.fields.filter((field) => field.kind === "media");
}

function assertSupportedOutputs(capability: Capability): void {
  for (const field of mediaOutputFields(capability)) {
    if (field.cardinality.min !== 1 || field.cardinality.max !== 1 || field.produces.length !== 1 || field.produces[0] !== "image/png") {
      throw new MmpError("unsupported_type", `Click-In 尚未接入 ${field.name} 的输出渲染：${field.produces.join(", ")}`);
    }
  }
}

async function prepareDeliveries(input: {
  capability: Capability;
  sessionId: string;
  userId: string;
  runId: string;
  toolCallId: string;
}) {
  const attachments: AgentAttachment[] = [];
  const delivery: NonNullable<Parameters<MmpClient["run"]>[0]["delivery"]> = {};
  for (const field of mediaOutputFields(input.capability)) {
    const attachment = await createPendingAttachment({
      sessionId: input.sessionId,
      userId: input.userId,
      fileName: `${field.name}.png`,
      mimeType: "image/png",
      mediaKind: "image",
      fileSize: AGENT_ATTACHMENT_MAX_BYTES,
      source: {
        kind: "mmp",
        runId: input.runId,
        toolCallId: input.toolCallId,
        outputName: field.name,
        outputIndex: 0,
        metadata: { capabilityId: input.capability.id, outputName: field.name, outputIndex: 0 },
      },
    });
    const put = presignedPut(attachment.r2Key, attachment.mimeType, 60 * 60);
    delivery[field.name] = { url: put.url, headers: { "Content-Type": put.contentType } };
    attachments.push(attachment);
  }
  return { attachments, delivery };
}

async function verifyAndFinalize(
  capability: Capability,
  done: Awaited<ReturnType<MmpClient["run"]>>,
  attachments: AgentAttachment[],
  userId: string,
): Promise<{ attachments: AgentAttachment[]; media: CapabilityRunResult["media"] }> {
  const metadata = jsonOutputs(done);
  const ready: AgentAttachment[] = [];
  const media: CapabilityRunResult["media"] = [];
  const fields = mediaOutputFields(capability);
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    const attachment = attachments[index];
    const output = done.outputs[field.name];
    if (!output || Array.isArray(output) || output.kind !== "media") throw new Error(`${field.name} 没有返回单值 media output`);
    const declared = output;
    if (declared.delivered !== true || declared.content_type !== "image/png") throw new Error(`${field.name} 未按受控 PUT 交付 image/png`);
    const head = await headR2Object(attachment.r2Key);
    if (!head || head.size == null) throw new Error(`${field.name} 的交付对象不存在`);
    if (head.size !== declared.bytes || head.size > AGENT_ATTACHMENT_MAX_BYTES) throw new Error(`${field.name} 的实际字节数与声明不符或超过上限`);
    if (head.contentType?.split(";", 1)[0].toLowerCase() !== "image/png") throw new Error(`${field.name} 的实际 Content-Type 不是 image/png`);
    const object = await getR2Object(attachment.r2Key);
    if (!object) throw new Error(`${field.name} 的交付对象不可读`);
    const sha256 = createHash("sha256").update(object.body).digest("hex");
    if (sha256 !== declared.sha256.toLowerCase()) throw new Error(`${field.name} 的 digest 校验失败`);
    const dimensions = pngDimensions(object.body);
    if (!dimensions) throw new Error(`${field.name} 不是有效 PNG`);
    if (!matchingDimensions(metadata, dimensions)) throw new Error(`${field.name} 的 PNG 尺寸与结构化 metadata 不一致`);
    const sourceMetadata = {
      capabilityId: capability.id, jobId: done.job_id, outputName: field.name, outputIndex: 0,
      contentType: declared.content_type, bytes: declared.bytes, sha256,
      width: dimensions.width, height: dimensions.height,
      engine: done.source.engine, engineVersion: done.source.engine_version,
      tier: done.source.tier, generatedAt: done.source.generated_at, outputs: metadata,
    };
    const finalized = attachment.status === "ready"
      ? attachment
      : await markAttachmentReady(attachment.id, attachment.sessionId, userId, head.size, sourceMetadata);
    if (!finalized) throw new Error(`${field.name} 无法登记为 ready 附件`);
    ready.push(finalized);
    media.push({ type: "image", mimeType: finalized.mimeType, attachmentId: finalized.id,
      fileName: finalized.fileName, source: { kind: "attachment", sha256 } });
  }
  return { attachments: ready, media };
}

export async function runMmpCapability(
  args: {
    capability: Capability;
    rawArguments: Record<string, unknown>;
    resolveMedia: CapabilityMediaResolver;
    tier?: string;
    userId: string;
    productionId: string | null;
    sessionId: string;
    runId: string;
    toolCallId: string;
    onStatus?: (status: MmpRunStatus) => void;
  },
  opts: { client?: MmpClient | null; signal?: AbortSignal } = {},
): Promise<CapabilityRunResult> {
  const client = opts.client === undefined ? getMmpClient() : opts.client;
  if (!client) throw new MmpError("node_offline", "MMP 服务未配置");
  let pendingAttachments: AgentAttachment[] = [];
  try {
    const current = (await client.capabilities()).capabilities.find((entry) => entry.capability.id === args.capability.id)?.capability;
    if (!current) throw new MmpError("unsupported_type", `${args.capability.id} 当前没有在线节点提供`);
    const tier = args.tier?.trim() || undefined;
    if (tier && !current.tiers.some((item) => item.tier === tier)) throw new MmpError("unsupported_type", `${current.id}@${tier} 当前没有在线节点提供`);
    assertSupportedOutputs(current);

    const jobArguments: Record<string, unknown> = {};
    const cacheKeys: string[] = [];
    const mediaCacheKeys = new Map<string, string[]>();
    for (const field of current.input.fields) {
      const raw = args.rawArguments[field.name];
      if (raw === undefined || raw === null) {
        if (field.required) throw new MmpError("bad_request", `缺少必填参数 ${field.name}`);
        continue;
      }
      if (field.kind === "media") {
        const resolved = await args.resolveMedia(field.name, raw, current);
        jobArguments[field.name] = resolved.value;
        cacheKeys.push(...resolved.cacheKeys);
        mediaCacheKeys.set(field.name, resolved.cacheKeys);
      } else jobArguments[field.name] = raw;
    }

    const prepared = await prepareDeliveries({ capability: current, sessionId: args.sessionId,
      userId: args.userId, runId: args.runId, toolCallId: args.toolCallId });
    pendingAttachments = prepared.attachments;
    const done = await admittedMmpRun(client, {
      type: current.id,
      arguments: jobArguments,
      ...(Object.keys(prepared.delivery).length ? { delivery: prepared.delivery } : {}),
      ...(tier ? { tier: tier as "cpu" | "gpu-fast" | "gpu" | "remote" } : {}),
      priority: "interactive",
    }, {
      pollWaitSec: POLL_WAIT_SEC, timeoutMs: RUN_TIMEOUT_MS, signal: opts.signal,
      onStatus: (status) => args.onStatus?.({ status: status.status, etaSec: status.eta_sec, queuePosition: status.queue_position }),
    }, createHash("sha256").update(JSON.stringify([current.id, args.rawArguments, cacheKeys])).digest("hex"));

    for (const [fieldName, keys] of mediaCacheKeys) {
      const ids = done.media_ids[fieldName];
      const values = typeof ids === "string" ? [ids] : ids ?? [];
      keys.forEach((key, index) => { if (values[index]) rememberMmpMediaId(key, values[index]); });
    }

    const finalized = await verifyAndFinalize(current, done, pendingAttachments, args.userId);
    if (!done.cached) {
      const compute = billableMmpCompute(done, () => legacyComputeMs(done.timings_ms));
      await recordMmpUsage({ userId: args.userId, productionId: args.productionId, type: current.id,
        tier: String(done.usage?.tier ?? done.source.tier), computeMs: compute.ms, sourceId: done.job_id });
    }
    return { text: renderTextOutputs(current, done, finalized.attachments), ...finalized };
  } catch (error) {
    await Promise.all(pendingAttachments.map((attachment) =>
      scheduleAttachmentDeletion(attachment.id, attachment.sessionId, args.userId).catch(() => false)));
    throw error;
  }
}
