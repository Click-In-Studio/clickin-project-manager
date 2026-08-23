export type JsonObject = Record<string, unknown>;

export type JsonObjectResult =
  | { ok: true; value: JsonObject }
  | { ok: false; response: Response };

/**
 * API 路由统一的 JSON 对象解析入口。
 *
 * `Request.json()` 会在畸形 JSON 时抛异常；直接调用会被 Next.js 变成 500。
 * 本项目的写接口请求体都是对象，因此数组、null 与标量也在这里统一报 400。
 */
export async function readJsonObject(req: Pick<Request, "json">): Promise<JsonObjectResult> {
  let value: unknown;
  try {
    value = await req.json();
  } catch {
    return {
      ok: false,
      response: Response.json({ error: "请求体必须是有效 JSON" }, { status: 400 }),
    };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      response: Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 }),
    };
  }
  return { ok: true, value: value as JsonObject };
}
