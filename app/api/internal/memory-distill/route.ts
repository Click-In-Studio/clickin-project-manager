import { type NextRequest } from "next/server";
import { distillAllUsers } from "@/lib/agent-memory/distill";

// 记忆蒸馏触发端点——服务器 crontab 定时打（建议每日一次）：
//   0 4 * * * curl -s -X POST -H "Authorization: Bearer $INTERNAL_NOTIFY_SECRET" \
//     http://127.0.0.1:3001/api/internal/memory-distill
// 与其他 internal 端点同一鉴权（INTERNAL_NOTIFY_SECRET）。

function authorized(req: NextRequest): boolean {
  const secret = process.env.INTERNAL_NOTIFY_SECRET;
  if (!secret) return false;
  return req.headers.get("Authorization") === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const results = await distillAllUsers();
  const summary = {
    distilled: results.filter((r) => r.status === "distilled").length,
    noNewData: results.filter((r) => r.status === "no-new-data").length,
    errors: results.filter((r) => r.status === "error"),
  };
  console.log("[memory-distill]", JSON.stringify(summary));
  return Response.json({ results, summary });
}
