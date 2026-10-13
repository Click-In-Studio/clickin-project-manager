import { NextResponse, type NextRequest } from "next/server";
import {
  requireUser,
  requireOwnership,
  toErrorResponse,
} from "@/lib/agent/chat/http";
import { parseSessionIdentity } from "@/lib/agent/tools/session-identity-parse";
import {
  modelCatalog,
  sessionModelSelection,
} from "@/lib/agent/runtime/model-settings-db";
import { defaultModelSelection } from "@/lib/agent/runtime/config";
export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;
  const key = req.nextUrl.searchParams.get("sessionKey");
  if (key) {
    const denied = requireOwnership(key, auth.userId);
    if (denied) return denied;
  }
  const productionId = key
    ? (parseSessionIdentity(key)?.productionId ?? null)
    : req.nextUrl.searchParams.get("productionId");
  try {
    return NextResponse.json({
      models: await modelCatalog(auth.userId, productionId),
      selection: key
        ? await sessionModelSelection(key)
        : defaultModelSelection(),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
