/**
 * 自建运行时本地冒烟的准备脚本（#367 S2）：造一个测试用户 + pro 档制作，签一枚登录
 * cookie，打印 curl 用得上的三样东西。只在本地开发库用；不会碰线上。
 *
 *   npx tsx scripts/agent-runtime-smoke-setup.ts
 *
 * 之后：
 *   curl -sN --noproxy '*' -H "Cookie: $COOKIE" -H 'Content-Type: application/json' \
 *     -X POST http://127.0.0.1:3000/api/agent/chat/stream \
 *     -d "{\"sessionKey\":\"$KEY\",\"message\":\"我参与了哪些制作？\"}"
 */
import fs from "node:fs";
import path from "node:path";

for (const line of fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

async function main() {
  const { upsertFeishuUser } = await import("../lib/db");
  const { createSession, SESSION_COOKIE } = await import("../lib/session");
  const { createNewSessionKey } = await import("../lib/agent-gateway/client");
  const { getPool } = await import("../lib/pg");
  const { makeProduction, setProductionTier } = await import("../tests/factories");

  const tag = Date.now().toString(36);
  const { userId } = await upsertFeishuUser(`smoke-open-${tag}`, `冒烟用户-${tag}`, null, false);
  const { prodId } = await makeProduction(userId);
  await setProductionTier(prodId, "pro");
  const cookie = `${SESSION_COOKIE}=${createSession({ userId, name: `冒烟用户-${tag}`, avatarUrl: null, isAdmin: false })}`;
  const key = createNewSessionKey(userId, prodId);
  console.log(`export COOKIE='${cookie}'`);
  console.log(`export KEY='${key}'`);
  console.log(`export PROD='${prodId}'`);
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
