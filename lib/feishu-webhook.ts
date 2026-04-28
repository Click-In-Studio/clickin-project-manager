import { getTenantAccessToken } from "./feishu-auth";
import { getPool } from "./pg";

const FEISHU_BASE = "https://open.feishu.cn/open-apis";

/** Fetch a user's display name from Feishu. Falls back to the open_id string. */
export async function getUserName(openId: string): Promise<string> {
  try {
    const token = await getTenantAccessToken();
    const res = await fetch(
      `${FEISHU_BASE}/contact/v3/users/${openId}?user_id_type=open_id`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json() as { code: number; data?: { user?: { name?: string } } };
    return data.data?.user?.name ?? openId;
  } catch {
    return openId;
  }
}

/**
 * Tester gate: returns true if the sender is allowed to trigger bot processing.
 * - If bot_testers table is empty → test mode is OFF, everyone passes.
 * - If bot_testers table has rows → only those open_ids pass.
 */
export async function isBotTester(openId: string): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query<{ open_id: string }>(
    "SELECT open_id FROM bot_testers",
  );
  if (rows.length === 0) return true; // test mode off
  return rows.some(r => r.open_id === openId);
}
