import { backfillAllMarkerMigrations } from "../lib/db";

backfillAllMarkerMigrations().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
