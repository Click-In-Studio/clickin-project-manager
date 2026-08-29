// LLM interface — OpenAI-compatible.
// Switch provider via LLM_PROVIDER env var: "openai" (default) | "deepseek"
// Each provider reads its own key and model env vars.

export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatOptions = {
  model?: string;
  /**
   * 正文预算。**推理模型上它是 CoT + 正文的总预算**——思维链先花，正文用剩下的。
   * 按正文长度估的值会被 CoT 吃光，见下面 REASONING_RETRY_MAX_TOKENS 的补救。
   */
  maxTokens?: number;
  temperature?: number;
  /**
   * true = 被截断（finish_reason='length'）的回答按失败处理，不返回半截内容。
   * 用于"输出会覆盖既有数据"的调用点（如记忆蒸馏覆盖写 MEMORY.md）——
   * 半截摘要写进去等于把长期记忆替换成一段残文，比报错糟得多。
   */
  rejectTruncated?: boolean;
};

/**
 * 推理模型把预算烧在 CoT 上时的重试预算（DeepSeek reasoner 系列上限 8K）。
 *
 * 2026-08-17 线上：DEEPSEEK_MODEL=deepseek-v4-pro 是推理模型，蒸馏传
 * maxTokens=2000，实测 reasoning_tokens=1874（94%）、finish_reason=length、
 * content 为空 → 每次蒸馏都报 "LLM returned empty response"。调用方按正文估
 * 预算没有错，错在这个参数在推理模型上语义不同——所以由这一层兜。
 */
const REASONING_RETRY_MAX_TOKENS = 8000;

/**
 * 预算不够导致的失败（finish_reason='length'）。与"模型真的没输出"分开，
 * 调用方才能对症处理——蒸馏的处理是**缩小输入**重来，而不是加大预算重试：
 * 预算有模型上限，输入没有，硬顶会变成天天失败、offset 永不推进。
 */
export class LlmBudgetError extends Error {
  constructor(message: string, readonly truncated: boolean) {
    super(message);
    this.name = "LlmBudgetError";
  }
}

type RawChoice = {
  message?: { content?: string; reasoning_content?: string };
  finish_reason?: string;
};

type RawCompletion = {
  choices?: RawChoice[];
  error?: { message: string };
  usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
};

type Attempt = {
  content: string;
  reasoning: string;
  finishReason: string;
  maxTokens: number;
  reasoningTokens: number;
};

type ProviderConfig = {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
};

function getProviderConfig(): ProviderConfig {
  const provider = process.env.LLM_PROVIDER ?? "openai";

  if (provider === "deepseek") {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set");
    return {
      baseUrl:      "https://api.deepseek.com/v1",
      apiKey,
      defaultModel: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    };
  }

  // Default: openai
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  return {
    baseUrl:      "https://api.openai.com/v1",
    apiKey,
    defaultModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  };
}

export async function chat(
  messages: Message[],
  options: ChatOptions = {},
): Promise<string> {
  const { baseUrl, apiKey, defaultModel } = getProviderConfig();
  const model = options.model ?? defaultModel;
  const requested = options.maxTokens ?? 1000;

  async function attempt(maxTokens: number): Promise<Attempt> {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens:  maxTokens,
        temperature: options.temperature ?? 0.7,
      }),
    });

    const data = await res.json() as RawCompletion;
    if (data.error) throw new Error(`LLM error (${model}): ${data.error.message}`);

    const choice = data.choices?.[0];
    return {
      content:        choice?.message?.content?.trim() ?? "",
      reasoning:      choice?.message?.reasoning_content?.trim() ?? "",
      finishReason:   choice?.finish_reason ?? "",
      maxTokens,
      reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    };
  }

  const usable = (a: Attempt) =>
    a.content !== "" && !(options.rejectTruncated && a.finishReason === "length");

  let a = await attempt(requested);
  // 预算被思维链吃光 → 用推理模型的上限重试一次。只在确认是推理模型
  // （回了 reasoning_content）且确实被截断时重试，普通模型不会多花这一次。
  if (!usable(a) && a.reasoning !== "" && a.finishReason === "length" && requested < REASONING_RETRY_MAX_TOKENS) {
    console.warn(
      `[llm] ${model} 的思维链用掉 ${a.reasoningTokens}/${requested} tokens，正文被挤没；`
      + `按 ${REASONING_RETRY_MAX_TOKENS} 重试一次`,
    );
    a = await attempt(REASONING_RETRY_MAX_TOKENS);
  }

  if (usable(a)) return a.content;

  // 报错要能一眼看出是预算问题还是模型真没输出——原来一律 "empty response"，
  // 线上排查时完全看不出跟推理模型的预算语义有关。
  const detail = [
    `model=${model}`,
    `finish_reason=${a.finishReason || "?"}`,
    `max_tokens=${a.maxTokens}`,
    a.reasoning !== "" ? `reasoning_tokens=${a.reasoningTokens}` : null,
    `content_len=${a.content.length}`,
  ].filter(Boolean).join(" ");

  // 预算问题单独成类型：调用方要靠它判断"该缩输入"，字符串匹配不可靠
  if (a.finishReason === "length") {
    throw new LlmBudgetError(
      a.content === ""
        ? `LLM returned empty response (${detail})`
        : `LLM response truncated (${detail})`,
      a.content !== "",
    );
  }
  throw new Error(`LLM returned empty response (${detail})`);
}
