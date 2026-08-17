import { timingSafeEqual } from "node:crypto";
import { type NextRequest } from "next/server";
import { distillAllUsers } from "@/lib/agent-memory/distill";

// 记忆蒸馏触发端点——服务器 crontab 定时打（建议每日一次）：
//   0 4 * * * curl -s -X POST -H "Authorization: Bearer $INTERNAL_NOTIFY_SECRET" \
//     http://127.0.0.1:3001/api/internal/memory-distill
// 与其他 internal 端点同一鉴权（INTERNAL_NOTIFY_SECRET）。

function authorized(req: NextRequest): boolean {
  const secret = process.env.INTERNAL_NOTIFY_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(req.headers.get("Authorization") ?? "");
  // 恒定时间比较（该路由经 nginx 对公网可达，虽仅 loopback 有意义的
  // 语义，防御性拉平比较时长）
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const results = await distillAllUsers();
  const summary = {
    distilled: results.filter((r) => r.status === "distilled").length,
    noNewData: results.filter((r) => r.status === "no-new-data").length,
    // 降过档才成功的：输入超预算，说明积压在变大或单条记录变长，值得留意。
    // 判定由 distill 模块给（档位表在那边），这里不拿常量比对——否则档位一改
    // 这个计数就静默失真。
    shrunk: results.filter((r) => r.status === "distilled" && r.shrunk).length,
    // 单条都塞不下、被跳过的记录——该条 episodic 永久不进长期记忆
    skipped: results.filter((r) => r.status === "skipped"),
    errors: results.filter((r) => r.status === "error"),
  };
  console.log("[memory-distill]", JSON.stringify(summary));
  return Response.json({ results, summary });
}
