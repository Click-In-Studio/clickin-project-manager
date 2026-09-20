import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/account/session";
import { TOKEN_COOKIE } from "@/lib/platform/feishu/feishu-auth";
import { requestOrigin } from "@/lib/account/request-origin";

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  cookieStore.delete(TOKEN_COOKIE);
  return NextResponse.redirect(new URL("/login", requestOrigin(req)));
}
