/**
 * Generates SQL to backfill production_role_permission for all productions.
 * Usage: npx tsx scripts/generate-backfill-sql.ts | ssh click-in "sudo -u postgres psql -d script_editor"
 */
import { ROLE_TEMPLATE_PERMISSIONS } from "../lib/permissions";

const productionIds = [
  "modlvhs01",
  "mon9yj731",
  "monc5bw51",
  "moq08zjn1",
  "mptecyzq1",
  "mrjzvp1i2",
  "mrq1fcuj1",
  "mrrm8je81",
];

const entries = Object.entries(ROLE_TEMPLATE_PERMISSIONS);

let sql = "BEGIN;\n\n";

for (const prodId of productionIds) {
  for (const [roleName, perms] of entries) {
    if (!perms.length) continue;
    const escapedName = roleName.replace(/'/g, "''");
    const permList = perms.map((p) => `'${p}'`).join(", ");
    sql += `INSERT INTO production_role_permission (role_id, permission_key)\n`;
    sql += `  SELECT pr.id, p.perm\n`;
    sql += `  FROM production_role pr\n`;
    sql += `  CROSS JOIN (VALUES ${perms.map((p) => `('${p}')`).join(", ")}) AS p(perm)\n`;
    sql += `  WHERE pr.production_id = '${prodId}' AND pr.name = '${escapedName}'\n`;
    sql += `ON CONFLICT DO NOTHING;\n\n`;
  }
}

sql += "COMMIT;\n";
process.stdout.write(sql);
