import { type NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getAppAccessToken } from "@/lib/feishu-auth";

const BASE = "https://open.feishu.cn/open-apis";

export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const token = req.nextUrl.searchParams.get("token");
  if (!token) return Response.json({ error: "缺少 token" }, { status: 400 });

  const appToken = await getAppAccessToken();

  const res = await fetch(
    `${BASE}/drive/v1/medias/batch_get_tmp_download_url?file_tokens=${encodeURIComponent(token)}`,
    { headers: { Authorization: `Bearer ${appToken}` } }
  );
  const data = (await res.json()) as {
    code: number;
    msg: string;
    data?: { tmp_download_urls?: { file_token: string; tmp_download_url: string }[] };
  };

  if (data.code !== 0 || !data.data?.tmp_download_urls?.length) {
    return Response.json({ error: `Feishu: ${data.msg}` }, { status: 502 });
  }

  const url = data.data.tmp_download_urls[0].tmp_download_url;
  return NextResponse.redirect(url, 302);
}
