import type { PoolClient } from "pg";
import { getPool } from "@/lib/pg";
import { getUserTier, getProductionPlan } from "@/lib/account/plan";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { parseSessionIdentity } from "../tools/session-identity-parse";
import type { ModelSelection, AgentModelInfo } from "../model-types";
import {
  configuredModels,
  defaultModelSelection,
  validateModelSelection,
} from "./config";

/** 资格来自当前会话语境；项目成员个人档位与项目模型资格正交。 */
export async function modelCatalog(
  userId: string,
  productionId: string | null,
  client?: PoolClient,
): Promise<AgentModelInfo[]> {
  let extended: boolean;
  if (productionId) {
    const context = await getProductionPermissionContext(
      userId,
      false,
      productionId,
      client,
    );
    if (!context)
      throw Object.assign(new Error("你不是该制作的成员"), { status: 403 });
    extended = (await getProductionPlan(productionId, client)).tier === "pro";
    if (!extended)
      return configuredModels().map((model) => ({
        ...model,
        available: false,
        unavailableReason: "本项目档位未开放 AI 助手",
      }));
  } else extended = (await getUserTier(userId, client)) !== null;
  return configuredModels().map((model) =>
    extended || model.key === "deepseek-flash"
      ? model
      : {
          ...model,
          available: false,
          unavailableReason: "个人创作者档可使用此模型",
        },
  );
}
export async function assertModelSelection(
  userId: string,
  productionId: string | null,
  value: unknown,
  client?: PoolClient,
): Promise<ModelSelection> {
  const selection = validateModelSelection(value);
  const model = (await modelCatalog(userId, productionId, client)).find(
    (item) => item.key === selection.modelKey,
  )!;
  if (!model.available)
    throw Object.assign(new Error(model.unavailableReason!), { status: 403 });
  return selection;
}
export async function sessionModelSelection(
  sessionId: string,
  client?: PoolClient,
): Promise<ModelSelection> {
  const row = (
    await (client ?? getPool()).query<{ model_selection: ModelSelection }>(
      "SELECT model_selection FROM agent_session WHERE id=$1",
      [sessionId],
    )
  ).rows[0];
  return row
    ? validateModelSelection(row.model_selection)
    : defaultModelSelection();
}
export async function runModelSelection(
  runId: string,
): Promise<ModelSelection> {
  const row = (
    await getPool().query<{ model_selection: ModelSelection }>(
      "SELECT model_selection FROM agent_run WHERE id=$1",
      [runId],
    )
  ).rows[0];
  if (!row) throw new Error("运行不存在");
  return validateModelSelection(row.model_selection);
}
export async function saveModelSelection(
  sessionId: string,
  userId: string,
  value: unknown,
): Promise<void> {
  const identity = parseSessionIdentity(sessionId);
  if (!identity || identity.userId !== userId)
    throw Object.assign(new Error("无权访问该会话"), { status: 403 });
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      sessionId,
    ]);
    const selection = await assertModelSelection(userId, identity.productionId ?? null, value, client);
    const written = await client.query(
      `INSERT INTO agent_session(id,user_id,production_id,model_selection) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(id) DO UPDATE SET model_selection=EXCLUDED.model_selection WHERE agent_session.user_id=$2 AND agent_session.production_id IS NOT DISTINCT FROM $3`,
      [
        sessionId,
        userId,
        identity.productionId ?? null,
        JSON.stringify(selection),
      ],
    );
    if (!written.rowCount)
      throw Object.assign(new Error("无权访问该会话"), { status: 403 });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
