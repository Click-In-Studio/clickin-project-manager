// LLM interface — currently OpenAI-compatible.
// To swap providers: add a new driver function and update `chat()`.

export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatOptions = {
  model?: string;       // overrides OPENAI_MODEL env var
  maxTokens?: number;
  temperature?: number;
};

export async function chat(
  messages: Message[],
  options: ChatOptions = {},
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
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

  if (data.error) throw new Error(`LLM error: ${data.error.message}`);
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("LLM returned empty response");
  return content;
}
