/**
 * One-off: backfill production_role_permission for all existing productions.
 * Run with: npx tsx scripts/backfill-role-permissions.ts
 */

import { getPool } from "../lib/pg";
import { seedProductionRoles } from "../lib/db";

async function main() {
  const pool = getPool();
  const res = await pool.query<{ id: string; name: string }>(
    "SELECT id, name FROM production ORDER BY created_at",
  );
  console.log(`Found ${res.rows.length} production(s).`);
  for (const prod of res.rows) {
    console.log(`  Seeding roles for ${prod.name} (${prod.id})…`);
    await seedProductionRoles(prod.id);
    console.log(`    done.`);
  }

  // Verify
  const check = await pool.query<{ name: string; perm_count: string }>(
    `SELECT pr.name, COUNT(prp.permission_key) AS perm_count
     FROM production_role pr
     LEFT JOIN production_role_permission prp ON prp.role_id = pr.id
     GROUP BY pr.name
     ORDER BY perm_count DESC`,
  );
  console.log("\nVerification (distinct role names across all productions):");
  for (const row of check.rows) {
    console.log(`  ${row.name}: ${row.perm_count} permissions`);
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
