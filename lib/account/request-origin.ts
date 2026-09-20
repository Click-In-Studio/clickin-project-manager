import type { NextRequest } from "next/server";

function isLoopback(host: string): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

/**
 * 对外可见的站点 origin——拼 OAuth redirect_uri、邮件魔法链接、登录后跳转都用它。
 *
 * 协议不能信请求头：反代漏配 X-Forwarded-Proto 时，Next 会按入站 socket 自己补一个
 * `x-forwarded-proto: http`（base-server 的 `??=`），下游根本看不到「缺头」，任何
 * `?? "https"` 回退都是死分支——线上就这样把 redirect_uri 拼成了 http://（#591）。
 * 公网域名一律 https（80 口本就 301 过去），只有本机回环才照请求头/明文来。
 * host 仍取请求头：app / backstage 两个域共用一个进程，cookie 按域走，不能写死。
 */
export function requestOrigin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return req.nextUrl.origin;
  const proto = isLoopback(host) ? (req.headers.get("x-forwarded-proto") ?? "http") : "https";
  return `${proto}://${host}`;
}
