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
  MediaContent,
  Model,
  NativeMediaCapability,
  SimpleStreamOptions,
  TextContent,
} from "../../../vendor/openclaw/packages/llm-core/src/types";

export function mediaAdapterAvailable(
  api: string,
  capability: NativeMediaCapability,
): boolean {
  if (api === "google-generative-ai") return true;
  if (api === "openai-completions")
    return ["image", "audio", "video"].includes(capability.kind);
  return false;
}

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
  if (media.type === "video") return { type: "video_url", video_url: { url } };
  return { type: "image_url", image_url: { url } };
}

/** SDK 处理工具、思考和用量；此边界负责原件序列化，不让媒体标记漏入请求。 */
function prepareSdkRequest(
  model: Model,
  context: Context,
  options?: SimpleStreamOptions,
): { model: SdkModel; context: SdkContext; options: SimpleStreamOptions } {
  const parts = new Map<string, Record<string, unknown>>();
  const nonce = randomUUID();
  let totalBytes = 0;
  let totalChars = 0;
  let byteLimit = Infinity;
  let charLimit = Infinity;
  const budgets = new Map<
    NativeMediaCapability,
    { bytes: number; chars: number; count: number }
  >();
  const checkBudget = (media: MediaContent) => {
    const capability = model.nativeMedia?.find(
      (item) =>
        item.kind === media.type && item.mimeTypes.includes(media.mimeType),
    );
    if (!capability)
      throw new Error(
        `原生媒体适配器不可用：${model.id}/${model.api} ${media.mimeType}`,
      );
    const prior = budgets.get(capability) ?? { bytes: 0, chars: 0, count: 0 };
    const bytes = media.data
      ? Buffer.byteLength(media.data, "base64")
      : media.budget?.bytes;
    if (bytes === undefined)
      throw new Error("原生文件引用缺少媒体预算，不能发送");
    const next = {
      bytes: prior.bytes + bytes,
      chars: prior.chars + (media.data?.length ?? 0),
      count: prior.count + 1,
    };
    if (
      bytes > capability.maxBytes ||
      next.bytes > capability.maxRequestBytes ||
      next.chars > capability.maxRequestBase64Chars ||
      next.count > capability.maxCount
    )
      throw new Error("实际 provider 请求超过原生媒体字节数/base64/数量预算");
    totalBytes += bytes;
    totalChars += media.data?.length ?? 0;
    byteLimit = Math.min(byteLimit, capability.maxRequestBytes);
    charLimit = Math.min(charLimit, capability.maxRequestBase64Chars);
    if (totalBytes > byteLimit || totalChars > charLimit)
      throw new Error("混合模态实际请求超过媒体传输预算");
    budgets.set(capability, next);
  };
  const translate = (content: Array<TextContent | MediaContent>) =>
    content.map((part): TextContent => {
      if (part.type === "text") return part;
      const marker = `clickin-media:${nonce}:${parts.size}`;
      const serialized = serializeMedia(model, part);
      checkBudget(part);
      parts.set(marker, serialized);
      return { type: "text", text: marker };
    });
  const messages: SdkContext["messages"] = [];
  for (const message of context.messages) {
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
        content: message.content.filter(
          (part): part is TextContent => part.type === "text",
        ),
      });
      const media = message.content.filter(
        (part): part is MediaContent => part.type !== "text",
      );
      if (media.length)
        messages.push({
          role: "user",
          content: translate(media),
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
        return (await options?.onPayload?.(adapted, model)) ?? adapted;
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
