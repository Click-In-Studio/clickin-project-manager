import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const LOCAL_SCRIPT_DATA_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "local-script-data-migration-snapshot.json",
);

export type LocalScriptDataSnapshot = {
  productionIds: {
    stagePlay: string;
    musical: string;
    explicitFilm: string;
  };
  roleId: string;
};

export async function isLocalScriptDataPreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ pending: boolean }>(
    `SELECT
       NOT EXISTS (
         SELECT 1 FROM grant_template
         WHERE production_type IS NULL
           AND role_name = '*'
           AND permission_key = 'script:comment'
       )
       AS pending`,
  );
  return rows[0]?.pending ?? false;
}

export async function createLocalScriptDataPreMigrationData(
  pool: Pool,
): Promise<LocalScriptDataSnapshot> {
  const suffix = faker.string.alphanumeric(8).toLowerCase();
  const productionIds = {
    stagePlay: `ls_stage_${suffix}`,
    musical: `ls_musical_${suffix}`,
    explicitFilm: `ls_film_${suffix}`,
  };
  await pool.query(
    `INSERT INTO production (id, name, type, script_config) VALUES
       ($1, 'Local script migration stage play', 'stage_play', '{}'::jsonb),
       ($2, 'Local script migration musical', 'musical', '{}'::jsonb),
       ($3, 'Local script migration explicit film', 'film',
        '{"useRehearsalMarks": true, "pageLayout": "letter"}'::jsonb)`,
    [productionIds.stagePlay, productionIds.musical, productionIds.explicitFilm],
  );
  const roleId = `ls_role_${suffix}`;
  await pool.query(
    `INSERT INTO production_role (id, production_id, name)
     VALUES ($1, $2, 'Local migration role')`,
    [roleId, productionIds.stagePlay],
  );
  return { productionIds, roleId };
}
