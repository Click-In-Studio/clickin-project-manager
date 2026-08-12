import { config } from "dotenv";
config({ path: ".env.local" });
import { submitAccessRequest } from "@/lib/db";

async function main() {
  const req = await submitAccessRequest(
    "mod1uc2dg",
    "00000000-dead-beef-0000-000000000099",
    {
      resourceType: "cue_list",
      resourceId: "clmrsq26rv1",
      permissionLevel: "edit",
      grantType: "permanent",
      note: "我需要编辑这张 Cue 表以便在演出前完成 cue 整理",
    },
  );
  console.log("request id:", req.id, "status:", req.status);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
