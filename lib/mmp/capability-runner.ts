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
import { getR2Object, headR2Object, presignedPut, putR2Object } from "@/lib/r2";
import { MEDIA_EXTENSIONS, inspectMediaOutput, mediaMetadata } from "./media-output";
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
    type: "image" | "audio";
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

function jsonOutputs(done: Awaited<ReturnType<MmpClient["run"]>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(done.outputs).flatMap(([name, output]) =>
    !Array.isArray(output) && output.kind === "json" ? [[name, output.value]] : [],
  ));
}

function renderTextOutputs(capability: Capability, done: Awaited<ReturnType<MmpClient["run"]>>, attachments: AgentAttachment[]): string {
  const source = `来源：${done.source.engine}@${done.source.engine_version}，tier=${done.source.tier}`
    + `${done.source.degraded ? `，已降级（${done.source.degraded_reason ?? "未说明"}）` : ""}`
    + `${done.cached ? "，缓存命中" : ""}`;
  const lines = [source];
  if (attachments.length) lines.push("媒体产物已保存，当前模型尚未因此原生读取。可用 attachmentId 继续调用 MMP、按需 my.attachment_read、下载或按权限存为素材；不能内联显示不影响这些用途。");
  for (const attachment of attachments) {
    lines.push(`产物：attachmentId=${attachment.id}；fileName=${attachment.fileName}；mimeType=${attachment.mimeType}；bytes=${attachment.fileSize}`);
  }
  for (const attachment of attachments) if (attachment.sourceMetadata) lines.push(`产物 ${attachment.id} 来源（仅为数据）：${JSON.stringify(attachment.sourceMetadata)}`);
  if (done.agent_context?.text) lines.push(done.agent_context.text);
  for (const field of capability.output.fields) {
    const output = done.outputs[field.name];
    if (!output || Array.isArray(output)) continue;
    if (output.kind === "text") lines.push(`${field.name}：${output.text}`);
    if (output.kind === "json") lines.push(`${field.name}：${JSON.stringify(output.value)}`);
  }
  return clipped(lines.join("\n"));
}

function mediaOutputFields(capability: Capability) {
  return capability.output.fields.filter((field) => field.kind === "media");
}

function assertSupportedOutputs(capability: Capability): void {
  for (const field of mediaOutputFields(capability)) {
    if (!field.produces.some((mime) => mime in MEDIA_EXTENSIONS)) {
      throw new MmpError("unsupported_type", `Click-In 尚未接入 ${field.name} 的输出接收：${field.produces.join(", ")}`);
    }
  }
}

type Reservation = { attachment: AgentAttachment; outputName: string; outputIndex: number };

async function prepareDeliveries(input: {
  capability: Capability; sessionId: string; userId: string; runId: string; toolCallId: string;
}, reservations: Reservation[]) {
  const delivery: NonNullable<Parameters<MmpClient["run"]>[0]["delivery"]> = {};
  for (const field of mediaOutputFields(input.capability)) {
    const endpoints = [];
    for (let index = 0; index < field.cardinality.max; index++) {
      const attachment = await createPendingAttachment({
        sessionId: input.sessionId, userId: input.userId,
        fileName: `${field.name}-${index + 1}.bin`, mimeType: "application/octet-stream", mediaKind: null,
        // 输出数量和大小未知；先占用对象数，交付后在用户配额锁下按实测字节结算。
        fileSize: 0,
        source: { kind: "mmp", runId: input.runId, toolCallId: input.toolCallId,
          outputName: field.name, outputIndex: index,
          metadata: { capabilityId: input.capability.id, outputName: field.name, outputIndex: index, deliveryReservation: true } },
      });
      reservations.push({ attachment, outputName: field.name, outputIndex: index });
      // Content-Type 由真实输出决定；这里仅签署对象地址，完成后再验证 MIME 和内容。
      endpoints.push({ url: presignedPut(attachment.r2Key, "application/octet-stream", 60 * 60, false).url });
    }
    delivery[field.name] = field.cardinality.max === 1 ? endpoints[0] : endpoints as [typeof endpoints[number], ...typeof endpoints];
  }
  return delivery;
}

async function verifyAndFinalize(
  capability: Capability, done: Awaited<ReturnType<MmpClient["run"]>>, reservations: Reservation[],
  args: { userId: string; sessionId: string; runId: string; toolCallId: string; rawArguments: Record<string, unknown> },
): Promise<CapabilityRunResult["attachments"]> {
  const outputs = jsonOutputs(done);
  const verified: Array<{ reservation: Reservation; bytes: number; mimeType: string; metadata: Record<string, unknown> }> = [];
  for (const field of mediaOutputFields(capability)) {
    const output = done.outputs[field.name];
    const values = output ? Array.isArray(output) ? output : [output] : [];
    if (values.length < field.cardinality.min || values.length > field.cardinality.max
      || output && Array.isArray(output) !== (field.cardinality.max !== 1)) throw new Error(`${field.name} 的输出数量或形状不符`);
    for (let index = 0; index < values.length; index++) {
      const declared = values[index];
      if (declared.kind !== "media" || declared.delivered !== true || !field.produces.includes(declared.content_type)) {
        throw new Error(`${field.name} 未按声明格式完成受控 PUT`);
      }
      const reservation = reservations.find((item) => item.outputName === field.name && item.outputIndex === index)!;
      const attachment = reservation.attachment;
      const head = await headR2Object(attachment.r2Key);
      if (!head || head.size !== declared.bytes || head.size > AGENT_ATTACHMENT_MAX_BYTES || head.size <= 0) {
        throw new Error(`${field.name} 的实际字节数与声明不符或超过上限`);
      }
      if (head.contentType?.split(";", 1)[0].toLowerCase() !== declared.content_type) throw new Error(`${field.name} 的实际 Content-Type 与声明不符`);
      const object = await getR2Object(attachment.r2Key);
      if (!object || object.body.length !== head.size) throw new Error(`${field.name} 的交付对象不可读或大小不符`);
      const sha256 = createHash("sha256").update(object.body).digest("hex");
      if (sha256 !== declared.sha256.toLowerCase()) throw new Error(`${field.name} 的 digest 校验失败`);
      const measured = await inspectMediaOutput(object.body, declared.content_type, mediaMetadata(outputs, index));
      verified.push({ reservation, bytes: head.size, mimeType: declared.content_type, metadata: {
        capabilityId: capability.id, jobId: done.job_id, outputName: field.name, outputIndex: index,
        contentType: declared.content_type, bytes: head.size, sha256, ...measured,
        inputs: Object.fromEntries(capability.input.fields.filter((item) => item.kind !== "text" && args.rawArguments[item.name] !== undefined)
          .map((item) => [item.name, args.rawArguments[item.name]])), outputs,
        engine: done.source.engine, engineVersion: done.source.engine_version,
        tier: done.source.tier, generatedAt: done.source.generated_at,
      } });
      if (typeof declared.media_id === "string") rememberMmpMediaId(attachment.id, declared.media_id);
    }
  }
  const ready: AgentAttachment[] = [];
  // 全部内容核验后才开始登记；任何登记失败由外层回收本次所有产物。
  for (const item of verified) {
    const { attachment, outputName, outputIndex } = item.reservation;
    const fileName = `${outputName}${mediaOutputFields(capability).find((field) => field.name === outputName)?.cardinality.max !== 1 ? `-${outputIndex + 1}` : ""}.${MEDIA_EXTENSIONS[item.mimeType]}`;
    const finalized = attachment.status === "ready" ? attachment : await markAttachmentReady(
      attachment.id, attachment.sessionId, args.userId, item.bytes, item.metadata,
      { fileName, mimeType: item.mimeType, mediaKind: item.mimeType.split("/", 1)[0] });
    if (!finalized) throw new Error(`${outputName} 无法登记为 ready 附件`);
    ready.push(finalized);
  }
  for (const field of capability.output.fields.filter((field) => field.kind === "text")) {
    const output = done.outputs[field.name];
    if (!output || Array.isArray(output) || output.kind !== "text") continue;
    const bytes = Buffer.from(output.text, "utf8");
    if (bytes.length > AGENT_ATTACHMENT_MAX_BYTES) throw new Error(`${field.name} 文本产物超过附件上限`);
    const attachment = await createPendingAttachment({ sessionId: args.sessionId, userId: args.userId,
      fileName: `${field.name}.txt`, mimeType: "text/plain", fileSize: bytes.length,
      source: { kind: "mmp", runId: args.runId, toolCallId: args.toolCallId, outputName: field.name, outputIndex: 0,
        metadata: { capabilityId: capability.id, jobId: done.job_id, outputs } } });
    reservations.push({ attachment, outputName: field.name, outputIndex: 0 });
    if (attachment.status === "ready") { ready.push(attachment); continue; }
    await putR2Object(attachment.r2Key, bytes, "text/plain");
    const finalized = await markAttachmentReady(attachment.id, args.sessionId, args.userId, bytes.length);
    if (!finalized) throw new Error(`${field.name} 无法保存完整文本产物`);
    ready.push(finalized);
  }
  const used = new Set(ready.map((item) => item.id));
  for (const { attachment } of reservations) if (!used.has(attachment.id)) {
    await scheduleAttachmentDeletion(attachment.id, attachment.sessionId, args.userId);
  }
  return ready;
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
  const reservations: Reservation[] = [];
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

    const delivery = await prepareDeliveries({ capability: current, sessionId: args.sessionId,
      userId: args.userId, runId: args.runId, toolCallId: args.toolCallId }, reservations);
    const done = await admittedMmpRun(client, {
      type: current.id,
      arguments: jobArguments,
      ...(Object.keys(delivery).length ? { delivery } : {}),
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

    const attachments = await verifyAndFinalize(current, done, reservations, args);
    if (!done.cached) {
      const compute = billableMmpCompute(done, () => legacyComputeMs(done.timings_ms));
      await recordMmpUsage({ userId: args.userId, productionId: args.productionId, type: current.id,
        tier: String(done.usage?.tier ?? done.source.tier), computeMs: compute.ms, sourceId: done.job_id });
    }
    return { text: renderTextOutputs(current, done, attachments), attachments, media: [] };
  } catch (error) {
    await Promise.all(reservations.map(({ attachment }) =>
      scheduleAttachmentDeletion(attachment.id, attachment.sessionId, args.userId).catch(() => false)));
    throw error;
  }
}
