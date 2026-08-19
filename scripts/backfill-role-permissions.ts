/**
 * One-off: backfill production_role_permission for all existing productions.
 * Run with: npx tsx scripts/backfill-role-permissions.ts
 *
 * 只补**已有角色行**的权限键（从 grant_template 灌，幂等）。建角色行本身归项目模版
 * （lib/production-template.ts），而模版**只作用于新建演出**——不要拿它回灌存量演出，
 * 那会往人家项目里凭空塞一棵部门树。
 */

import { getPool } from "../lib/pg";
import { seedRoleFromTemplate } from "../lib/grant-template";

async function main() {
  const pool = getPool();
  const res = await pool.query<{ id: string; name: string; type: string | null }>(
    "SELECT id, name, type FROM production ORDER BY created_at",
  );
  console.log(`Found ${res.rows.length} production(s).`);
  for (const prod of res.rows) {
    console.log(`  Seeding roles for ${prod.name} (${prod.id})…`);
    const roles = await pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM production_role WHERE production_id = $1",
      [prod.id],
    );
    for (const role of roles.rows) {
      await seedRoleFromTemplate(role.id, role.name, prod.type);
    }
    console.log(`    done (${roles.rows.length} roles).`);
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
