import { type NextRequest, NextResponse } from "next/server";

// Legacy alias: redirect to the generic Feishu callback route
export async function GET(req: NextRequest) {
  const { search } = req.nextUrl;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return NextResponse.redirect(new URL(`/api/auth/feishu/callback${search}`, `${proto}://${host}`));
}
