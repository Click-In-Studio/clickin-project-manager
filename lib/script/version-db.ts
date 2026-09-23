/**
 * 版本（version 表）数据层。
 *
 * 版本退役 Phase B 之后版本是线性的：每个演出只有 createInitialVersion 建的一条活跃
 * 版本（production.active_version_id = head），历史多版本行只读保留，name / description /
 * tags / status 列已删。这里只剩读 head、读一条版本、建初始版本三件事；写路由的
 * 「只许写 head」守卫在 head-version.ts。
 */
import { getPool } from "../pg";
import type { PoolClient } from "pg";

export type Version = {
  id: string;
  productionId: string;
  parentVersionId: string | null;
  createdAt: string;
};

type VersionRow = {
  id: string;
  production_id: string;
  parent_version_id: string | null;
  created_at: Date;
};

function rowToVersion(r: VersionRow): Version {
  return {
    id: r.id,
    productionId: r.production_id,
    parentVersionId: r.parent_version_id,
    createdAt: r.created_at.toISOString(),
  };
}

/** 开场章 = 该版本里排在最前的 chapter_marker（派生值，不落库，#636）；没有章时为 null。 */
export async function getVersionOpeningChapterId(versionId: string): Promise<string | null> {
  const res = await getPool().query<{ id: string }>(
    `SELECT sv.block_id AS id
     FROM script_version sv
     JOIN script s ON s.id = sv.snapshot_id
     WHERE sv.version_id = $1 AND s.type = 'chapter_marker'
     ORDER BY sv.sort_key
     LIMIT 1`,
    [versionId]
  );
  return res.rows[0]?.id ?? null;
}

export async function getVersion(versionId: string): Promise<Version | null> {
  const res = await getPool().query<VersionRow>(
    "SELECT id, production_id, parent_version_id, created_at FROM version WHERE id = $1",
    [versionId]
  );
  return res.rows.length ? rowToVersion(res.rows[0]) : null;
}

/** Returns the most recently created editing version, or null if none. */
export async function getActiveVersionId(productionId: string): Promise<string | null> {
  const res = await getPool().query<{ active_version_id: string | null }>(
    "SELECT active_version_id FROM production WHERE id = $1",
    [productionId]
  );
  return res.rows[0]?.active_version_id ?? null;
}

function genVersionId(): string {
  return `ver_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Creates the very first empty version for a brand-new production. */
/** 传 external ＝调用方已经在事务里了，就用它的连接，BEGIN/COMMIT/release 全归调用方。 */
export async function createInitialVersion(
  productionId: string, external?: PoolClient,
): Promise<string> {
  const versionId = genVersionId();
  const write = async (client: PoolClient) => {
    await client.query(
      "INSERT INTO version (id, production_id) VALUES ($1, $2)",
      [versionId, productionId]
    );
    await client.query(
      "UPDATE production SET active_version_id = $1 WHERE id = $2",
      [versionId, productionId]
    );
  };
  if (external) {
    await write(external);
    return versionId;
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await write(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return versionId;
}

// 版本退役 Phase B：createVersion / rollbackToVersion / updateVersionMeta /
// updateVersionStatus 已删除。版本从此线性：每个演出只有 createInitialVersion
// 建的一条活跃版本，历史多版本数据只读保留。未来的「历史记录 / checkpoint」
// 概念在此地基上另行设计，不复用分叉语义。
