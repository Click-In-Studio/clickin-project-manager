// MMP 温层关注点：不用墙钟时间，以最近三个用户轮次维持短程连续性。
// 来源包括用户附带的临时附件、UI 当前资产，以及模型成功读取过的具体 asset。

import { matchesMediaType, type Capability } from "@mmp/client";
import { assetIdsFromContext, attachmentIdsFromContext } from "@/lib/agent/agent-ui-context";
import { getReadyAttachments } from "@/lib/agent/attachment-db";
import { resolveReadableAsset } from "@/lib/agent/tools/doc-tools";
import { capabilityContentType } from "@/lib/mmp/attachment-preflight";
import type { AgentMessage } from "../../../vendor/openclaw/packages/agent-core/src/types";
import { exposedName } from "./tools";
import { mmpCapabilityToolName } from "./mmp-tools";

export const MMP_FOCUS_USER_TURNS = 3;
const FOCUS_RESOURCE_CAP = 8;

const ASSET_READ_TOOLS = new Set([
  "production.asset_preflight",
  "production.doc_outline",
  "production.doc_read",
  "production.doc_search",
  "production.doc_page_ocr",
].map(exposedName));

function textOf(message: AgentMessage): string {
  const content = (message as { content?: Array<{ type?: string; text?: string }> }).content;
  return Array.isArray(content)
    ? content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("")
    : "";
}

function recentSlice(messages: AgentMessage[]): AgentMessage[] {
  let turns = 0;
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    turns++;
    if (turns === MMP_FOCUS_USER_TURNS) { start = i; break; }
  }
  return messages.slice(start);
}

function successfulAssetCalls(messages: AgentMessage[]): string[] {
  const successful = new Set(messages
    .filter((message) => message.role === "toolResult" && !message.isError)
    .map((message) => message.role === "toolResult" ? message.toolCallId : ""));
  const ids: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const item of message.content) {
      if (item.type !== "toolCall" || !successful.has(item.id)) continue;
      const isAssetTool = ASSET_READ_TOOLS.has(item.name) || item.name.startsWith("clickin__mmp-asset-");
      const assetId = (item.arguments as { assetId?: unknown } | undefined)?.assetId;
      if (isAssetTool && typeof assetId === "string" && assetId && !ids.includes(assetId)) ids.push(assetId);
    }
  }
  return ids;
}

function matchingNames(capabilities: Capability[], contentTypes: Iterable<string>, scope: "attachment" | "asset"): string[] {
  const types = [...contentTypes];
  return capabilities
    .filter((capability) => types.some((contentType) => capability.input.media.accepts.some((pattern) => matchesMediaType(pattern, contentType))))
    .map((capability) => mmpCapabilityToolName(scope, capability.id));
}

export async function focusedMmpToolNames(args: {
  messages: AgentMessage[];
  currentMessage?: string;
  currentAttachmentIds?: string[];
  sessionId: string;
  userId: string;
  productionId: string | null;
  capabilities: Capability[];
}): Promise<string[]> {
  if (!args.capabilities.length) return [];
  const recent = recentSlice(args.messages);
  const userTexts = recent.filter((message) => message.role === "user").map(textOf);
  if (args.currentMessage) userTexts.push(args.currentMessage);

  const attachmentIds = [...new Set([
    ...(args.currentAttachmentIds ?? []),
    ...userTexts.flatMap(attachmentIdsFromContext),
  ])].slice(-FOCUS_RESOURCE_CAP);
  const attachments = await getReadyAttachments(attachmentIds, args.sessionId, args.userId);
  const attachmentTypes = attachments.map((attachment) => capabilityContentType({
    mediaKind: attachment.mediaKind,
    mimeType: attachment.mimeType,
  }));

  const assetIds = [...new Set([
    ...userTexts.flatMap(assetIdsFromContext),
    ...successfulAssetCalls(recent),
  ])].slice(-FOCUS_RESOURCE_CAP);
  const assetTypes = args.productionId
    ? (await Promise.all(assetIds.map(async (assetId) => {
        const got = await resolveReadableAsset(args.userId, args.productionId!, assetId);
        return typeof got === "string" ? null : got.asset.mimeType ?? "application/octet-stream";
      }))).filter((contentType): contentType is string => contentType !== null)
    : [];

  return [...new Set([
    ...matchingNames(args.capabilities, attachmentTypes, "attachment"),
    ...matchingNames(args.capabilities, assetTypes, "asset"),
  ])];
}

export function mmpAttachmentToolNamesFor(
  capabilities: Capability[],
  attachments: Array<{ mediaKind?: string | null; mimeType: string }>,
): string[] {
  const types = attachments.map(capabilityContentType);
  return matchingNames(capabilities, types, "attachment");
}
