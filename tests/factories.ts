import { faker } from "@faker-js/faker";
import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/pg";
import {
  createProduction,
  upsertFeishuUser,
  deleteProduction,
  getActiveVersionId,
  flushToDBVersioned,
  applyPatchToDB,
} from "@/lib/db";
import type { Block } from "@/lib/script-types";
import type { ScriptPatch } from "@/lib/script-ops";

// ── ID helpers ────────────────────────────────────────────────────────────────

// Short alphanumeric production/cue-list IDs (matches seed data style)
export function shortId(): string {
  return `t${faker.string.alphanumeric(7).toLowerCase()}`;
}

// ── Production ────────────────────────────────────────────────────────────────

/**
 * 建一个演出，返回 id + 自动建出的初始 version id。
 *
 * `production.owner_id` 是 NOT NULL（owner 是 M-14(c) 责任链的终点，不存在无主演出），
 * 故不传 owner 时**自动造一个专属 owner 用户**——调用方拿到的仍是"我不关心 owner"的
 * 语义，但库里不会出现 NULL。要测 owner 旁路请显式传自己的 userId。
 */
export async function makeProduction(ownerUserId?: string): Promise<{ prodId: string; versionId: string }> {
  const id = shortId();
  const owner = ownerUserId
    ?? (await upsertFeishuUser(`test-open-${shortId()}`, `工厂owner-${shortId()}`, null, false)).userId;
  await createProduction(id, faker.company.name(), owner);
  const versionId = (await getActiveVersionId(id))!;
  return { prodId: id, versionId };
}

/**
 * Delete a production, cleaning up scene_version and character_version rows
 * first (those FKs lack ON DELETE CASCADE and would otherwise block the delete).
 */
export async function cleanupProduction(prodId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    "DELETE FROM character_version WHERE character_id IN (SELECT id FROM character WHERE production_id = $1)",
    [prodId],
  );
  await pool.query(
    "DELETE FROM scene_version WHERE scene_id IN (SELECT id FROM scene WHERE production_id = $1)",
    [prodId],
  );
  await deleteProduction(prodId);
}

// ── Legacy multi-version state ────────────────────────────────────────────────

/**
 * 模拟「版本退役 Phase B」之前的遗留多版本数据：从 fromVersionId 复制出一个
 * 新的活跃版本（共享 snapshot / cue revision，ref_count 变为 2+），旧版本沦为
 * 只读历史。生产代码已不再有制造这种状态的入口——这个工厂用裸 SQL
 * 复刻老 createVersion 的复制语义，专供 CoW（历史只读保护）分支的测试。
 */
export async function makeLegacyVersion(
  prodId: string,
  fromVersionId: string,
): Promise<string> {
  const pool = getPool();
  const newVersionId = `ver_${faker.string.alphanumeric(10).toLowerCase()}`;
  await pool.query(
    `INSERT INTO version (id, production_id, parent_version_id, created_at, script_config, marker_structure_revision)
     SELECT $1, $2, $3, now(), COALESCE(script_config, '{}'::jsonb), marker_structure_revision
     FROM version WHERE id = $3`,
    [newVersionId, prodId, fromVersionId],
  );
  await pool.query(
    "INSERT INTO script_version (snapshot_id, version_id, block_id, sort_key) SELECT snapshot_id, $1, block_id, sort_key FROM script_version WHERE version_id = $2",
    [newVersionId, fromVersionId],
  );
  await pool.query(
    "INSERT INTO cue_version (revision_id, version_id, cue_id) SELECT revision_id, $1, cue_id FROM cue_version WHERE version_id = $2",
    [newVersionId, fromVersionId],
  );
  await pool.query(
    `INSERT INTO scene_version (scene_id, version_id, name, sort_order, parent_id,
                                synopsis, action_line, music, stage_notes, expected_duration)
     SELECT scene_id, $1, name, sort_order, parent_id,
            synopsis, action_line, music, stage_notes, expected_duration
     FROM scene_version WHERE version_id = $2`,
    [newVersionId, fromVersionId],
  );
  await pool.query(
    `INSERT INTO character_version (character_id, version_id, name, sort_order, is_aggregate, gender, biography, role_type)
     SELECT character_id, $1, name, sort_order, is_aggregate, gender, biography, role_type FROM character_version WHERE version_id = $2`,
    [newVersionId, fromVersionId],
  );
  await pool.query("UPDATE production SET active_version_id = $1 WHERE id = $2", [newVersionId, prodId]);
  return newVersionId;
}

// ── Scene ─────────────────────────────────────────────────────────────────────

/**
 * Add a scene to an existing version. Returns the new sceneId (UUID).
 * Additive — does not clear existing blocks or characters.
 */
export async function makeScene(
  productionId: string,
  versionId: string,
  opts?: { number?: string; name?: string },
): Promise<string> {
  const sceneId = randomUUID();
  const block: Block = {
    id: sceneId,
    type: "chapter_marker",
    content: "",
    characterIds: [],
    characterAnnotations: {},
    lyric: false,
    sceneId: null,
    rehearsalMark: null,
    markerMeta: {
      number: opts?.number ?? faker.number.int({ min: 1, max: 99 }).toString(),
      name: opts?.name ?? faker.lorem.word(),
    },
  };
  await applyPatchToDB(productionId, versionId, insOp(block));
  return sceneId;
}

// ── Character ─────────────────────────────────────────────────────────────────

/**
 * Add a character to an existing version. Returns the new characterId (UUID).
 * Additive — does not clear existing blocks or scenes.
 */
export async function makeCharacter(
  productionId: string,
  versionId: string,
  opts?: { name?: string },
): Promise<string> {
  const charId = randomUUID();
  await flushToDBVersioned(productionId, versionId, {
    upsertBlocks: [],
    deleteSnapshotIds: [],
    upsertChars: [
      {
        id: charId,
        name: opts?.name ?? faker.person.fullName(),
        isAggregate: false,
        sortOrder: 1,
      },
    ],
    deleteCharIds: [],
    upsertScenes: [],
    deleteSceneIds: [],
  });
  return charId;
}

// ── Script blocks ─────────────────────────────────────────────────────────────

function mkBlock(id: string, content: string): Block {
  return {
    id,
    type: "dialogue",
    content,
    characterIds: [],
    characterAnnotations: {},
    lyric: false,
    sceneId: null,
    rehearsalMark: null,
  };
}

function insOp(block: Block, afterId: string | null = null): ScriptPatch {
  return {
    clientSeq: 1,
    blockOps: [{ op: "insert", block, afterId }],
    charOps: [],
    sceneOps: [],
  };
}

/**
 * Insert `count` dialogue blocks into a version via applyPatchToDB.
 * Returns the block ids. Additive — does not clear existing blocks.
 */
export async function makeBlocks(
  productionId: string,
  versionId: string,
  count = 1,
): Promise<string[]> {
  const ids: string[] = [];
  let afterId: string | null = null;
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    ids.push(id);
    await applyPatchToDB(productionId, versionId, insOp(mkBlock(id, faker.lorem.sentence()), afterId));
    afterId = id;
  }
  return ids;
}
