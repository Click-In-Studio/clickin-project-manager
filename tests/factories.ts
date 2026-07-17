import { faker } from "@faker-js/faker";
import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/pg";
import {
  createProduction,
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
 * Create a production and return its id + auto-created initial version id.
 */
export async function makeProduction(): Promise<{ prodId: string; versionId: string }> {
  const id = shortId();
  await createProduction(id, faker.company.name());
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
  await flushToDBVersioned(productionId, versionId, {
    upsertScenes: [
      {
        id: sceneId,
        number: opts?.number ?? faker.number.int({ min: 1, max: 99 }).toString(),
        name: opts?.name ?? faker.lorem.word(),
        parentId: null,
        sortOrder: 1,
      },
    ],
    deleteSceneIds: [],
    upsertBlocks: [],
    deleteSnapshotIds: [],
    upsertChars: [],
    deleteCharIds: [],
  });
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
