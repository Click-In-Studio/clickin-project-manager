// 协议 3.1：先取得真实输出，再按引用与实际数量签发交付地址。
import { media, type Capability, type MmpClient } from "@mmp/client";
import { AGENT_ATTACHMENT_MAX_BYTES, createPendingAttachment, type AgentAttachment } from "@/lib/agent/attachment-db";
import { presignedPut } from "@/lib/r2";
import { admittedMmpRun } from "./admitted-run";
import { MEDIA_EXTENSIONS } from "./media-output";

export type Reservation = { attachment: AgentAttachment; outputName: string; outputIndex: number };
type Done = Awaited<ReturnType<MmpClient["run"]>>;
type Output = Done["outputs"][string];
type MediaOutput = Extract<Exclude<Output, unknown[]>, { kind: "media" }>;

export async function deliverMediaOutputs(
  client: MmpClient, capability: Capability, done: Done,
  args: { sessionId: string; userId: string; runId: string; toolCallId: string },
  reservations: Reservation[], signal?: AbortSignal,
): Promise<void> {
  const outputs: Array<{ name: string; index: number; value: MediaOutput; array: boolean }> = [];
  for (const field of capability.output.fields) {
    if (field.kind !== "media") continue;
    const output = done.outputs[field.name];
    const values = output ? Array.isArray(output) ? output : [output] : [];
    if (values.length < field.cardinality.min || values.length > field.cardinality.max
      || output && Array.isArray(output) !== (field.cardinality.max !== 1)) throw new Error(`${field.name} 的输出数量或形状不符`);
    for (const [index, value] of values.entries()) {
      if (value.kind !== "media" || !field.produces.includes(value.content_type) || !(value.content_type in MEDIA_EXTENSIONS)
        || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > AGENT_ATTACHMENT_MAX_BYTES) {
        throw new Error(`${field.name} 的媒体描述不符或超过上限`);
      }
      outputs.push({ name: field.name, index, value, array: field.cardinality.max !== 1 });
    }
  }
  if (!outputs.length) return;
  const deliveryCapability = await client.resolveCapability({ purpose: "media.deliver", contentType: outputs[0].value.content_type });
  const input = deliveryCapability.input.fields.find((field) => field.kind === "media");
  const output = deliveryCapability.output.fields.find((field) => field.kind === "media");
  if (!input || input.kind !== "media" || !output || input.cardinality.max < 1) throw new Error("MMP 交付能力未声明媒体批次");
  // job_id 契约为 <node_id>-<26 位 ULID>；ref 只存在于产出它的节点。
  const nodeId = done.job_id.slice(0, -27);
  if (!nodeId) throw new Error("MMP 结果缺少产出节点身份");
  for (const item of outputs) {
    const attachment = await createPendingAttachment({
      sessionId: args.sessionId, userId: args.userId,
      fileName: `${item.name}${item.array ? `-${item.index + 1}` : ""}.${MEDIA_EXTENSIONS[item.value.content_type]}`,
      mimeType: item.value.content_type, mediaKind: item.value.content_type.split("/", 1)[0], fileSize: item.value.bytes,
      source: { kind: "mmp", runId: args.runId, toolCallId: args.toolCallId, outputName: item.name, outputIndex: item.index,
        metadata: { capabilityId: capability.id, jobId: done.job_id, outputName: item.name, outputIndex: item.index } },
    });
    reservations.push({ attachment, outputName: item.name, outputIndex: item.index });
  }
  for (let start = 0; start < outputs.length; start += input.cardinality.max) {
    const batch = outputs.slice(start, start + input.cardinality.max);
    const targets = reservations.slice(start, start + batch.length);
    const delivered = await admittedMmpRun(client, {
      type: deliveryCapability.id, node_id: nodeId,
      arguments: { [input.name]: batch.map((item) => media.ref(item.value.media_id)) },
      delivery: { [output.name]: targets.map(({ attachment }) => ({ url: presignedPut(attachment.r2Key, attachment.mimeType).url })) as [{ url: string }, ...{ url: string }[]] },
      priority: "interactive",
    }, { signal, timeoutMs: 10 * 60_000, pollWaitSec: 30 }, JSON.stringify([done.job_id, targets.map((item) => item.attachment.id)]));
    const receipts = delivered.outputs[output.name];
    if (!Array.isArray(receipts) || receipts.length !== batch.length || receipts.some((receipt, index) => {
      const expected = batch[index].value;
      return receipt.kind !== "media" || receipt.delivered !== true || receipt.media_id !== expected.media_id
        || receipt.sha256 !== expected.sha256 || receipt.bytes !== expected.bytes || receipt.content_type !== expected.content_type;
    })) throw new Error("MMP 未按引用和实际数量完成受控 PUT");
  }
}
