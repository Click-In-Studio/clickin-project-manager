import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session";
import { TOKEN_COOKIE } from "@/lib/feishu-auth";

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  cookieStore.delete(TOKEN_COOKIE);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return NextResponse.redirect(new URL("/login", `${proto}://${host}`));
}
