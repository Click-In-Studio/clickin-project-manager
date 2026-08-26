/**
 * Pre-migration snapshot for migrate-cue-mention-stable-id.sql（#302）invariance tests.
 *
 * isMigrationNeeded: cue.cue_id 仍可空。迁移的第一步就是回填并收 NOT NULL，
 *   所以"列还可空"是干净的结构判据（不像纯 DML 迁移那样需要备份表当判据）。
 *
 * createPreMigrationData: 造迁移前形态——一个逻辑 cue 的多条 CoW 修订，正文与边
 *   都锚在**修订行 id** 上。不能走应用层 helper：代码已改成锚 cue_id（这正是本次
 *   迁移要平移的存量），走 createCue/updateWiki 造出来的就是迁移后形态。
 *
 * 层 3 要钉的是**平移方向**：正文里的行 id 必须变成该逻辑 cue 的 cue_id，且
 *   - 前缀不得被咬断（remap 键 `<id>` 可能是另一行 id 的前缀，裸 replace 会截断）；
 *   - 同一 wiki 指向同一逻辑 cue 的多条修订边必须去重成一行（否则撞主键）；
 *   - 悬空边与别的 kind 不得被殃及。
 *   这几条错了都是静默数据损坏，人工推不回来。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const CUE_MENTION_STABLE_ID_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "cue-mention-stable-id-migration-snapshot.json",
);

export type CueMentionStableIdSnapshot = {
  prodId: string;
  cueListId: string;
  /** 逻辑 cue A 的初版行 id —— 同时就是它的 cue_id（平移目标） */
  logicalA: string;
  /** A 的 CoW 修订行 id（正文/边锚在这些上，迁移后都该变成 logicalA） */
  revA2: string;
  /** A 的另一条修订；其 id 是 revAprefix 的**前缀**，用来钉裸 replace 的咬断陷阱 */
  revAshort: string;
  /** 逻辑 cue B 的初版行 id（= cue_id） */
  logicalB: string;
  /** B 的修订行 id，以 revAshort 为前缀 —— 迁移后必须完整变成 logicalB */
  revBprefixed: string;
  /** 迁移前 cue_id 为 NULL 的存量行（迁移后应回填为自身 id） */
  legacyNullCue: string;
  wikiId: string;
  commentId: string;
  notificationId: string;
  memoryChunkId: string;
  /** 悬空边（宿主行不存在）的 entity_id —— 迁移后原样保留 */
  danglingEdgeId: string;
};

/** cue.cue_id 是否仍可空 —— 迁移后为 NOT NULL。 */
export async function isCueMentionStableIdPreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'cue' AND column_name = 'cue_id'`,
  );
  return rows[0]?.is_nullable === "YES";
}

export async function createCueMentionStableIdPreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<CueMentionStableIdSnapshot> {
  const tag = faker.string.alphanumeric(6).toLowerCase();
  const prodId = `t${tag}`;
  const cueListId = `cl${tag}`;

  // 前缀陷阱的两个证人：revAshort 是 revBprefixed 的严格前缀，且 revAshort 本身
  // 是一条 remap 键（它的 cue_id ≠ 自身）。裸 replace 会把 revBprefixed 咬成
  // 「logicalA + 尾巴」——层 3 有一条专测钉这个。
  const logicalA = `cueA${tag}`;
  const revA2 = `cueA2${tag}`;
  const revAshort = `cueS${tag}`;
  const logicalB = `cueB${tag}`;
  const revBprefixed = `${revAshort}x`;
  const legacyNullCue = `cueN${tag}`;
  const danglingEdgeId = `cueGone${tag}`;

  await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)", [
    prodId, faker.company.name(), testUserId,
  ]);
  await pool.query(
    "INSERT INTO cue_list (id, production_id, name, abbr, created_by) VALUES ($1, $2, $3, $4, $5)",
    [cueListId, prodId, "音效", `SQ${tag.slice(0, 3).toUpperCase()}`, testUserId],
  );

  // (行 id, cue_id) —— 迁移前形态：修订行的 cue_id 指向初版行 id
  const rows: [string, string | null][] = [
    [logicalA, logicalA],
    [revA2, logicalA],
    [revAshort, logicalA],
    [logicalB, logicalB],
    [revBprefixed, logicalB],
    [legacyNullCue, null],
  ];
  for (const [id, cueId] of rows) {
    await pool.query(
      `INSERT INTO cue (id, cue_id, cue_list_id, number, name, start_kind, end_kind)
       VALUES ($1, $2, $3, $4, $5, 'gap', 'gap')`,
      [id, cueId, cueListId, "1", "开场音"],
    );
  }

  // 正文：v2 形态 + 各种尾随分隔符 + 不该动的干扰项。
  //
  // ⚠️ wiki.body 里**只准放 v2 形态**：wiki-dialect-v2.migration.test.ts 有一条
  // 全库不变量「wiki.body 不再残留任何 v1 形态」，而本迁移只换 id 不换文法
  // （`/__cm__cue:old` → `/__cm__cue:new` 仍是 v1），种进来就是永久 straggler。
  // v1 分支的证人放在 comment.body（无此不变量）——见下方。
  const body = [
    `开场 [#SQ.1](/__cm__/cue/${revA2}) 提前两秒。`,
    `追光 [#SQ.2](/__cm__/cue/${revBprefixed}) 同步。`,
    `另一条修订 [#SQ.1](/__cm__/cue/${revAshort}) 也要收。`,
    `带锚 [#SQ.1](/__cm__/cue/${revA2}#note) 与参数 [#SQ.1](/__cm__/cue/${revA2}?as=x)。`,
    `不该动：${revAshort} 裸文本、/__cm__/scene/${revA2} 别的 kind。`,
  ].join("\n");

  const wiki = await pool.query<{ id: string }>(
    `INSERT INTO wiki (production_id, title, body, created_by)
     VALUES ($1, '换锚工厂', $2, $3) RETURNING id::text AS id`,
    [prodId, body, testUserId],
  );
  const wikiId = wiki.rows[0].id;

  // 边：两条不同修订 → 平移后同目标同 origin，必须去重成一行（保留最早 created_at）；
  // manual 边同目标但 origin 不同 → 各自保留；悬空边与别的 kind → 不得被殃及。
  // created_at 写成带 Z 的绝对时刻：去重保留最早那条，断言不该受服务器时区影响
  const edges: [string, string, string, string][] = [
    ["cue", revA2, "wiki_body", "2026-01-02T00:00:00Z"],
    ["cue", revAshort, "wiki_body", "2026-01-01T00:00:00Z"],
    ["cue", revBprefixed, "manual", "2026-01-03T00:00:00Z"],
    ["cue", danglingEdgeId, "wiki_body", "2026-01-04T00:00:00Z"],
    ["scene", revA2, "wiki_body", "2026-01-05T00:00:00Z"],
  ];
  for (const [type, entityId, origin, createdAt] of edges) {
    await pool.query(
      `INSERT INTO wiki_entity_link (wiki_id, production_id, entity_type, entity_id, origin, created_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::timestamptz)`,
      [wikiId, prodId, type, entityId, origin, createdAt],
    );
  }

  // wiki.body 之外的三条正文列（与 migrate-wiki-dialect-v2 盘清的列集一致）。
  // comment.body 兼作 **v1 形态证人**：dialect v2 之后正常库里不该再有 v1，本迁移
  // 的 v1 分支是防「dialect v2 被回滚」的保险。comment 没有 canonical-v2 不变量，
  // 是唯一能安全长期承载这个证人的地方。
  const commentId = `cm${tag}`;
  await pool.query(
    `INSERT INTO comment (id, production_id, context_type, context_id, author_name, body, user_id)
     VALUES ($1, $2, 'cue', $3, $4, $5, $6)`,
    [commentId, prodId, revA2, "工厂", `见 [#SQ.1](/__cm__cue:${revA2}?v=v1) 的处理`, testUserId],
  );

  const notificationId = `n${tag}`;
  await pool.query(
    `INSERT INTO user_notification (id, user_id, kind, entity_type, entity_id, title, body)
     VALUES ($1, $2, 'mention', 'cue', $3, '提及', $4)`,
    [notificationId, testUserId, revA2, `[#SQ.1](/__cm__/cue/${revA2}) 有新评论`],
  );

  const memory = await pool.query<{ id: string }>(
    `INSERT INTO agent_memory_chunk
       (scope_type, scope_id, source, text, text_tokens, content_hash,
        origin_class, session_kind, observed_at)
     VALUES ('production', $1, 'curated', $2, '', $3, 'owner', 'interactive', now())
     RETURNING id::text AS id`,
    [prodId, `记住 [#SQ.1](/__cm__/cue/${revA2}) 是开场音`, `h${tag}`],
  );

  return {
    prodId, cueListId,
    logicalA, revA2, revAshort,
    logicalB, revBprefixed,
    legacyNullCue,
    wikiId,
    commentId,
    notificationId,
    memoryChunkId: memory.rows[0].id,
    danglingEdgeId,
  };
}
