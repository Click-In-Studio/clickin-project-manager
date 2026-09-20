import { type NextRequest, NextResponse } from "next/server";
import { requestOrigin } from "@/lib/account/request-origin";

// Legacy alias: redirect to the generic Feishu callback route
export async function GET(req: NextRequest) {
  const { search } = req.nextUrl;
  return NextResponse.redirect(new URL(`/api/auth/feishu/callback${search}`, requestOrigin(req)));
}
