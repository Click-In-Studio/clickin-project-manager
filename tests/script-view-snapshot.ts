/**
 * Pre-migration snapshot for migrate-script-view.sql（#336 B2）invariance tests.
 *
 * isMigrationNeeded: script_view 表还不存在。
 *
 * createPreMigrationData: 在旧 schema 上用裸 SQL 造迁移前形态（不能走 createProduction——
 *   新代码建项目会顺手建 script_view，在旧 schema 上直接报错，而且造出来的就是迁移后形态）：
 *   · 一个 **letter + compact** 的演出，page_map 按四种版式串键、各有内容（存量真实形状）
 *     → 迁移后主本必须是 letter/compact，page_map 只剩 { master: 原 letter 那份 }，
 *       script_config 里 pageLayout / textLayoutMode 两键消失、其余键原样
 *   · 一个 script_config 里**没有**版式键、page_map 为 '{}' 的演出（建项后从没改过版式）
 *     → 迁移后主本 a4/center，page_map 仍为 '{}'
 *   · 一个版式键是**非法值**的演出（防御：JSONB 无约束，谁都能写）
 *     → 落回 a4/center，不能让 CHECK 约束把整支迁移打断
 *
 * 层 3 要钉的是**版式不丢、页码不丢、其余设置不动**——这三条错了都是静默改变全剧组的页码。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const SCRIPT_VIEW_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "script-view-migration-snapshot.json",
);

export type ScriptViewSnapshot = {
  /** letter + compact，page_map 四份齐全 */
  letterProdId: string;
  letterVersionId: string;
  /** 迁移前 page_map.letter 那份（迁移后应原样挂在主本 id 下） */
  letterPageMap: Record<string, number>;
  /** 无版式键、page_map 空 */
  defaultProdId: string;
  /** 版式键为非法值 */
  invalidProdId: string;
};

export async function isScriptViewPreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'script_view'
  `);
  return rows.length === 0;
}

async function rawProduction(
  pool: Pool,
  ownerUserId: string,
  scriptConfig: Record<string, unknown>,
  pageMap: Record<string, Record<string, number>>,
): Promise<{ prodId: string; versionId: string }> {
  const tag = faker.string.alphanumeric(7).toLowerCase();
  const prodId = `t${tag}`;
  const versionId = `ver_svmig${tag}`;
  await pool.query(
    "INSERT INTO production (id, name, owner_id, script_config, page_map) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)",
    [prodId, faker.company.name(), ownerUserId, JSON.stringify(scriptConfig), JSON.stringify(pageMap)],
  );
  await pool.query("INSERT INTO version (id, production_id) VALUES ($1, $2)", [versionId, prodId]);
  await pool.query("UPDATE production SET active_version_id = $1 WHERE id = $2", [versionId, prodId]);
  return { prodId, versionId };
}

export async function createScriptViewPreMigrationData(
  pool: Pool,
  ownerUserId: string,
): Promise<ScriptViewSnapshot> {
  const letterPageMap = { blkA: 1, blkB: 1, blkC: 2 };
  const letter = await rawProduction(
    pool, ownerUserId,
    { stageDelimOpen: "（", stageDelimClose: "）", pageLayout: "letter", textLayoutMode: "compact", useRehearsalMarks: false },
    // 四份都造，且各不相同——迁移后只能剩 letter 那份，拿错了立刻看得出
    { a4: { blkA: 1, blkB: 2, blkC: 3 }, letter: letterPageMap, "a3-2col": { blkA: 1 }, "tablet-2col": { blkA: 9 } },
  );
  const dflt = await rawProduction(pool, ownerUserId, { useRehearsalMarks: true }, {});
  const invalid = await rawProduction(
    pool, ownerUserId,
    { pageLayout: "b5-weird", textLayoutMode: "sideways", useRehearsalMarks: true },
    {},
  );
  return {
    letterProdId: letter.prodId,
    letterVersionId: letter.versionId,
    letterPageMap,
    defaultProdId: dflt.prodId,
    invalidProdId: invalid.prodId,
  };
}
