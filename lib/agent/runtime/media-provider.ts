import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type {
  LlmRuntime as SdkRuntime,
  Context as SdkContext,
  Model as SdkModel,
} from "@openclaw/ai";
import type { AgentCoreRuntimeDeps } from "../../../vendor/openclaw/packages/agent-core/src/runtime-deps";
import type {
  Context,
  ImageContent,
  MediaContent,
  Model,
  SimpleStreamOptions,
  TextContent,
} from "../../../vendor/openclaw/packages/llm-core/src/types";

import { mediaAdapterAvailable, mediaBudget, requestMedia } from "./media-budget";

function serializeMedia(
  model: Model,
  media: MediaContent,
): Record<string, unknown> {
  const capability = model.nativeMedia?.find(
    (item) =>
      item.kind === media.type && item.mimeTypes.includes(media.mimeType),
  );
  if (!capability || !mediaAdapterAvailable(model.api, capability))
    throw new Error(
      `原生媒体适配器不可用：${model.id}/${model.api} ${media.mimeType}`,
    );
  if (!capability.transports.includes("inline") || !media.data)
    throw new Error("原生媒体尚未准备，不能丢弃媒体后继续请求");
  if (model.api === "google-generative-ai")
    return { inlineData: { mimeType: media.mimeType, data: media.data } };
  const url = `data:${media.mimeType};base64,${media.data}`;
  if (media.type === "audio")
    return {
      type: "input_audio",
      input_audio: {
        data: `data:;base64,${media.data}`,
        format:
          media.mimeType === "audio/mpeg"
            ? "mp3"
            : media.mimeType === "audio/mp4"
              ? "m4a"
              : media.mimeType.split("/")[1],
      },
    };
  return { type: "video_url", video_url: { url } };
}

/** 图片交给 SDK 按 provider 处理；此边界补充其余原件序列化，不让媒体标记漏入请求。 */
function prepareSdkRequest(
  model: Model,
  context: Context,
  options?: SimpleStreamOptions,
): { model: SdkModel; context: SdkContext; options: SimpleStreamOptions } {
  const parts = new Map<string, Record<string, unknown>>();
  const nonce = randomUUID();
  const budget = mediaBudget(model, requestMedia(context.messages));
  if (!budget.fits) throw new Error(budget.reasons.join("；"));
  const translate = (content: Array<TextContent | MediaContent>) =>
    content.map((part): TextContent | ImageContent => {
      if (part.type === "text") return part;
      if (part.type === "image") {
        if (!part.data) throw new Error("原生媒体尚未准备，不能丢弃媒体后继续请求");
        return { type: "image", mimeType: part.mimeType, data: part.data };
      }
      const serialized = serializeMedia(model, part);
      const marker = `clickin-media:${nonce}:${parts.size}`;
      parts.set(marker, serialized);
      return { type: "text", text: marker };
    });
  const messages: SdkContext["messages"] = [];
  const pendingToolMedia: SdkContext["messages"] = [];
  const flushToolMedia = () => {
    messages.push(...pendingToolMedia);
    pendingToolMedia.length = 0;
  };
  for (const message of context.messages) {
    // 同批工具响应保持连续；到下一条非工具消息前（或遍历结束时）才补入非图片媒体。
    if (message.role !== "toolResult") flushToolMedia();
    if (message.role === "assistant") {
      messages.push(message);
      continue;
    }
    if (message.role === "user" && typeof message.content === "string") {
      messages.push({ ...message, content: message.content });
      continue;
    }
    if (message.role === "toolResult") {
      messages.push({
        ...message,
        content: translate(message.content.filter(
          (part) => part.type === "text" || part.type === "image",
        )),
      });
      const media = message.content.filter(
        (part): part is MediaContent => part.type !== "text" && part.type !== "image",
      );
      if (media.length)
        // 非图片媒体也必须等同批工具响应收齐后补入，不能打断 SDK 的批次处理。
        pendingToolMedia.push({
          role: "user",
          content: [
            { type: "text", text: `工具 ${message.toolName}（调用 ${message.toolCallId}）返回的媒体：` },
            ...translate(media),
          ],
          timestamp: message.timestamp,
        });
    } else
      messages.push({
        ...message,
        content: translate(
          typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content,
        ),
      });
  }
  flushToolMedia();
  const sdkModel: SdkModel = {
    ...model,
    input: model.input.filter(
      (kind): kind is "text" | "image" => kind === "text" || kind === "image",
    ),
  };
  return {
    model: sdkModel,
    context: { ...context, messages },
    options: {
      ...options,
      onPayload: async (payload) => {
        const replaced = new Set<string>();
        const replace = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(replace);
          if (
            !value ||
            typeof value !== "object" ||
            Object.getPrototypeOf(value) !== Object.prototype
          )
            return value;
          const object = value as Record<string, unknown>;
          if (
            (object.type === "input_text" ||
              object.type === "text" ||
              !object.type) &&
            typeof object.text === "string" &&
            parts.has(object.text)
          ) {
            replaced.add(object.text);
            return parts.get(object.text);
          }
          return Object.fromEntries(
            Object.entries(object).map(([key, item]) => [key, replace(item)]),
          );
        };
        const adapted = replace(payload);
        if (
          model.provider === "qwen" &&
          adapted &&
          typeof adapted === "object"
        ) {
          const body = adapted as Record<string, unknown>;
          body.enable_thinking = options?.reasoning !== undefined;
          if (options?.reasoning) body.reasoning_effort = options.reasoning;
        }
        if (replaced.size !== parts.size)
          throw new Error("provider 序列化未保留全部媒体块，请求已停止");
        const final = (await options?.onPayload?.(adapted, model)) ?? adapted;
        if (model.maxRequestBytes !== undefined && Buffer.byteLength(JSON.stringify(final)) > model.maxRequestBytes)
          throw new Error("完整请求体超过目标模型的传输上限");
        return final;
      },
    },
  };
}

export function createMediaRuntime(sdk: SdkRuntime): AgentCoreRuntimeDeps {
  const streamSimple: AgentCoreRuntimeDeps["streamSimple"] = (
    model,
    context,
    options,
  ) => {
    try {
      const request = prepareSdkRequest(model, context, options);
      return sdk.streamSimple(request.model, request.context, request.options);
    } catch (error) {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const,
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: options?.signal?.aborted
          ? ("aborted" as const)
          : ("error" as const),
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({
        type: "error",
        reason: message.stopReason,
        error: message,
      });
      return stream;
    }
  };
  return {
    streamSimple,
    completeSimple: async (model, context, options) =>
      (await streamSimple(model, context, options)).result(),
  };
}
