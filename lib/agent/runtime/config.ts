import { configureAiTransportHost, createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import type {
  Model,
  NativeMediaCapability,
} from "../../../vendor/openclaw/packages/llm-core/src/types";
import {
  DEFAULT_MODEL_SELECTION,
  type AgentModelInfo,
  type ModelSelection,
} from "../model-types";
import { createMediaRuntime } from "./media-provider";
import { modelProxyFetch } from "./model-proxy";

export const COMPACTION_TOKEN_BUDGET = 128_000;
export const REQUEST_OUTPUT_TOKENS = 8_192;
const image: NativeMediaCapability = {
  kind: "image",
  mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  transports: ["inline"],
  maxBytes: 20 * 1024 * 1024,
  maxRequestBytes: 20 * 1024 * 1024,
  maxRequestBase64Chars: 28_000_000,
  maxCount: 8,
  maxPixels: 12_000_000,
  tokenEstimate: { minimum: 1200, perMegapixel: 1600 },
};
const pdf: NativeMediaCapability = {
  ...image,
  kind: "file",
  mimeTypes: ["application/pdf"],
  maxPages: 100,
  tokenEstimate: { minimum: 3000, perPage: 3000 },
};
const audio: NativeMediaCapability = {
  ...image,
  kind: "audio",
  mimeTypes: [
    "audio/wav",
    "audio/mpeg",
    "audio/mp4",
    "audio/webm",
    "audio/ogg",
    "audio/flac",
  ],
  maxDurationSeconds: 1200,
  tokenEstimate: { minimum: 1200, perSecond: 32 },
};
const video: NativeMediaCapability = {
  ...audio,
  kind: "video",
  mimeTypes: ["video/mp4", "video/webm", "video/quicktime"],
  maxDurationSeconds: 600,
  tokenEstimate: { minimum: 1200, perSecond: 400 },
};
// Qwen 音视频 inline base64 必须小于 10 MB，不能沿用图片的 20 MiB 上限。
const omniAudio = {
  ...audio,
  maxBytes: 7 * 1024 * 1024,
  maxRequestBytes: 7 * 1024 * 1024,
  maxRequestBase64Chars: 9_999_999,
};
const omniVideo = {
  ...video,
  maxBytes: omniAudio.maxBytes,
  maxRequestBytes: omniAudio.maxRequestBytes,
  maxRequestBase64Chars: omniAudio.maxRequestBase64Chars,
};
// Gemini inline 已支持 100 MB payload；为文字、工具和 JSON 留出 5 MB。
// https://ai.google.dev/gemini-api/docs/file-input-methods
const GOOGLE_INLINE_BASE64_CHARS = 95_000_000;
const GOOGLE_INLINE_BYTES = (GOOGLE_INLINE_BASE64_CHARS / 4) * 3;
const googleMedia = [image, pdf, audio, video].map((capability) => ({
  ...capability,
  maxBytes: capability.kind === "audio" ? GOOGLE_INLINE_BYTES : 14 * 1024 * 1024,
  maxRequestBytes: GOOGLE_INLINE_BYTES,
  maxRequestBase64Chars: GOOGLE_INLINE_BASE64_CHARS,
  mimeTypes:
    capability.kind === "image"
      ? ["image/png", "image/jpeg", "image/webp"]
      : capability.mimeTypes,
}));
interface Entry {
  info: Omit<AgentModelInfo, "available" | "unavailableReason">;
  credential: string;
  proxyEnv?: string;
  model: Model;
}
const entries: Entry[] = [
  {
    info: {
      key: "deepseek-flash",
      name: "澄思·轻量",
      description: "低成本文本与图片理解，默认模型。",
      costTier: "low",
      input: ["text", "image"],
      thinkingLevels: ["off", "low", "high", "max"],
    },
    credential: "DEEPSEEK_API_KEY",
    model: {
      id: "deepseek-flash",
      name: "澄思·轻量",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      reasoning: true,
      input: ["text", "image"],
      nativeMedia: [image],
      contextWindow: 1_000_000,
      contextTokens: COMPACTION_TOKEN_BUDGET,
      maxTokens: 384_000,
      cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
      compat: { maxTokensField: "max_tokens" },
      thinkingLevelMap: { max: "max" },
    },
  },
  {
    info: {
      key: "deepseek-pro",
      name: "澄思·进阶",
      description: "文本分析与复核，仅支持文本。",
      costTier: "medium",
      input: ["text"],
      thinkingLevels: ["off", "low", "high", "max"],
    },
    credential: "DEEPSEEK_API_KEY",
    model: {
      id: "deepseek-v4-pro",
      name: "澄思·进阶",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      reasoning: true,
      input: ["text"],
      contextWindow: 1_000_000,
      contextTokens: COMPACTION_TOKEN_BUDGET,
      maxTokens: 384_000,
      cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
      compat: { maxTokensField: "max_tokens" },
      thinkingLevelMap: { max: "max" },
    },
  },
  {
    info: {
      key: "resonance",
      name: "共鸣",
      description: "文本、图片与音视频联合理解，适合声音和画面材料。",
      costTier: "low",
      input: ["text", "image", "audio", "video"],
      thinkingLevels: ["off", "low", "medium", "high"],
    },
    credential: "EMBEDDING_API_KEY",
    model: {
      id: "qwen3.8-omni-flash",
      name: "共鸣",
      provider: "qwen",
      api: "openai-completions",
      baseUrl:
        process.env.EMBEDDING_BASE_URL ??
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      reasoning: true,
      input: ["text", "image", "audio", "video"],
      nativeMedia: [image, omniAudio, omniVideo],
      contextWindow: 1_000_000,
      contextTokens: COMPACTION_TOKEN_BUDGET,
      maxTokens: 131_072,
      cost: { input: 0.113, output: 0.382, cacheRead: 0.014, cacheWrite: 0 },
      compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false },
    },
  },
  {
    info: {
      key: "inspiration",
      name: "灵光",
      description: "文本、图片、PDF 与音视频理解，适合跨材料讨论和发散。",
      costTier: "medium",
      input: ["text", "image", "file", "audio", "video"],
      thinkingLevels: ["low", "medium", "high"],
    },
    credential: "GEMINI_API_KEY",
    proxyEnv: "GEMINI_PROXY_URL",
    model: {
      id: "gemini-3.8-flash",
      name: "灵光",
      provider: "google",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      reasoning: true,
      input: ["text", "image", "file", "audio", "video"],
      nativeMedia: googleMedia,
      contextWindow: 1_048_576,
      contextTokens: COMPACTION_TOKEN_BUDGET,
      maxTokens: 65_536,
      // 优惠结束后按正式价格登记，不移动历史计价与 credit 锚点。
      cost:
        new Date() < new Date("2027-01-01T00:00:00Z")
          ? { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 }
          : { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
    },
  },
];
export function modelEntry(key: string): Entry {
  const entry = entries.find((item) => item.info.key === key);
  if (!entry) throw Object.assign(new Error("模型未登记"), { status: 400 });
  return entry;
}
export function validateModelSelection(value: unknown): ModelSelection {
  const selection = value as ModelSelection | null;
  if (
    !selection ||
    typeof selection !== "object" ||
    !Array.isArray(selection.disabledSubagentModels) ||
    new Set(selection.disabledSubagentModels).size !==
      selection.disabledSubagentModels.length ||
    !modelEntry(selection.modelKey).info.thinkingLevels.includes(
      selection.thinkingLevel,
    )
  )
    throw Object.assign(new Error("模型选择或思考强度不合法"), { status: 400 });
  for (const key of selection.disabledSubagentModels) modelEntry(key);
  return {
    modelKey: selection.modelKey,
    thinkingLevel: selection.thinkingLevel,
    disabledSubagentModels: [...selection.disabledSubagentModels],
  };
}
export function defaultModelSelection(): ModelSelection {
  return { ...DEFAULT_MODEL_SELECTION, disabledSubagentModels: [] };
}
export function configuredModels(): AgentModelInfo[] {
  return entries.map(({ info, credential }) => ({
    ...info,
    available: Boolean(process.env[credential]),
    unavailableReason: process.env[credential] ? null : "服务端未配置模型",
  }));
}
export function resolveModel(key: string): Model {
  return modelEntry(key).model;
}
export function modelApiKey(model: Model): string {
  const entry = entries.find((item) => item.model.id === model.id);
  const key = entry && process.env[entry.credential];
  if (!key)
    throw Object.assign(new Error("服务端未配置所选模型"), { status: 503 });
  return key;
}
export const CHAT_MODEL = resolveModel(
  defaultModelSelection().modelKey,
) as Model & { input: Array<"text" | "image"> };
let runtime: ReturnType<typeof createMediaRuntime> | undefined;
export function llmRuntime() {
  if (!runtime) {
    configureAiTransportHost({
      buildModelFetch: (model) => {
        const entry = entries.find((item) => item.model.id === model.id);
        const proxyUrl = entry?.proxyEnv && process.env[entry.proxyEnv];
        return proxyUrl ? modelProxyFetch(proxyUrl) : undefined;
      },
    });
    const registry = createApiRegistry();
    registerBuiltInApiProviders(registry);
    runtime = createMediaRuntime(createLlmRuntime(registry));
  }
  return runtime;
}
export const RUNNER_OWNER = `${process.env.HOSTNAME ?? "local"}:${process.pid}`;
export const HEARTBEAT_INTERVAL_MS = Number(
  process.env.AGENT_HEARTBEAT_MS ?? 5_000,
);
export const ORPHAN_AFTER_MS = Number(
  process.env.AGENT_ORPHAN_AFTER_MS ?? 30_000,
);
export const APPROVAL_TTL_MS = Number(
  process.env.AGENT_APPROVAL_TTL_MS ?? 600_000,
);
