// LLM interface — OpenAI-compatible.
// Switch provider via LLM_PROVIDER env var: "openai" (default) | "deepseek"
// Each provider reads its own key and model env vars.

export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
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

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens:  options.maxTokens  ?? 1000,
      temperature: options.temperature ?? 0.7,
    }),
  });

  const data = await res.json() as {
    choices?: { message: { content: string } }[];
    error?:   { message: string };
  };

  if (data.error) throw new Error(`LLM error (${model}): ${data.error.message}`);
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("LLM returned empty response");
  return content;
}
