/**
 * 从 PG* 环境变量拼 dbmate / libpq 用的连接 URL。
 *
 * 纯函数、无副作用：调用方自己决定何时加载 .env.local（scripts/db.ts 加载，
 * CI 直接用 job 级 env）。与 lib/pg.ts 的 poolConfigFromEnv 读同一组变量，
 * 保证 dbmate 迁移的库和应用连的库是同一个。
 *
 * host 以 "/" 开头视为 Unix socket 目录（服务器上以 postgres 用户 peer auth 跑
 * 迁移就是这种形态：postgres:///script_editor?host=/var/run/postgresql）。
 */
export function databaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: { database?: string } = {},
): string {
  const database = overrides.database ?? env.PGDATABASE ?? "script_editor";
  const host = env.PGHOST ?? "localhost";
  const port = env.PGPORT ?? "5432";
  const user = env.PGUSER;
  const password = env.PGPASSWORD;

  const auth = user
    ? encodeURIComponent(user) + (password ? ":" + encodeURIComponent(password) : "") + "@"
    : "";

  if (host.startsWith("/")) {
    return `postgres://${auth}/${encodeURIComponent(database)}?host=${encodeURIComponent(host)}&sslmode=disable`;
  }
  return `postgres://${auth}${host}:${port}/${encodeURIComponent(database)}?sslmode=disable`;
}
