import { type NextRequest, NextResponse } from "next/server";
import { requestOrigin } from "@/lib/account/request-origin";

// Legacy alias: redirect to the generic Feishu initiate route
export async function GET(req: NextRequest) {
  return NextResponse.redirect(new URL("/api/auth/feishu/initiate", requestOrigin(req)));
}
