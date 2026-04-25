import { Pool } from "pg";

const g = global as typeof globalThis & { __pgPool?: Pool };

export function getPool(): Pool {
  if (!g.__pgPool) {
    g.__pgPool = new Pool({
      database: process.env.PGDATABASE ?? "script_editor",
      host: process.env.PGHOST ?? "localhost",
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
    });
  }
  return g.__pgPool;
}
