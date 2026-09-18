import { buildSearchIndex } from "@/lib/help/search-index";

// 手册搜索索引（#538）。公开（proxy 放行 /api/help/），内容随构建走，缓存一小时。
export async function GET() {
  return Response.json(buildSearchIndex(), {
    headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" },
  });
}
