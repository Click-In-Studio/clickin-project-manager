/**
 * Pre-migration factory data for migrate-internal-user-id invariance tests.
 *
 * createPreMigrationData creates a deterministic set of faker-seeded rows on
 * the OLD schema (open_id FK references). global-setup.ts calls this before
 * applying the migration, then writes the returned snapshot to SNAPSHOT_PATH.
 *
 * After migration, migration.test.ts reads the snapshot and verifies that
 * every openId maps faithfully to a userId — the invariance property that
 * schema and integrity checks cannot catch.
 *
 * Pattern for future migrations:
 *   1. Write a createPreMigrationData() that inserts representative rows on
 *      the OLD schema and returns a typed snapshot.
 *   2. Add corresponding invariance tests in the migration test file.
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import type { Faker } from "@faker-js/faker";

export const SNAPSHOT_PATH = path.join(os.tmpdir(), "migration-invariance-snapshot.json");

// ─── Snapshot types ───────────────────────────────────────────────────────────

export type FactoryUser = {
  openId: string;
  name: string;
};

export type FactoryMember = {
  productionId: string;
  openId: string;
};

export type FactoryCueList = {
  id: string;
  productionId: string;
  openId: string;
};

export type FactoryEvent = {
  id: string;
  productionId: string;
  openId: string;
};

export type FactoryComment = {
  id: string;
  productionId: string;
  openId: string;
  mentionOpenIds: string[];
};

export type PreMigrationSnapshot = {
  users: FactoryUser[];
  production: { id: string; name: string };
  members: FactoryMember[];
  cueLists: FactoryCueList[];
  events: FactoryEvent[];
  comments: FactoryComment[];
};

// ─── Schema check ─────────────────────────────────────────────────────────────

/** Returns true if the DB is still on the pre-migration schema. */
export async function isPreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'production_member' AND column_name = 'open_id'
  `);
  return rows.length > 0;
}

// ─── Pre-migration factory data ───────────────────────────────────────────────

/**
 * Inserts a faker-seeded set of rows on the OLD schema and returns a snapshot.
 * Must be called BEFORE the migration SQL runs.
 *
 * Creates N users, a production, production_member rows, cue_list rows,
 * production_event rows, and comment rows with JSONB mentions — one row per
 * table per user — so every migrated column has a verifiable before/after pair.
 */
export async function createPreMigrationData(
  pool: Pool,
  faker: Faker,
): Promise<PreMigrationSnapshot> {
  const N = 4;

  // ── feishu_user (old schema: no user_id column) ───────────────────────────
  const users: FactoryUser[] = Array.from({ length: N }, () => ({
    openId: `inv-${faker.string.alphanumeric(8).toLowerCase()}`,
    name: faker.person.fullName(),
  }));
  for (const u of users) {
    await pool.query(
      `INSERT INTO feishu_user (open_id, name, is_super_admin) VALUES ($1, $2, FALSE)`,
      [u.openId, u.name],
    );
  }

  // ── production ────────────────────────────────────────────────────────────
  const production = {
    id: `inv-${faker.string.alphanumeric(6).toLowerCase()}`,
    name: faker.company.name(),
  };
  await pool.query(
    `INSERT INTO production (id, name) VALUES ($1, $2)`,
    [production.id, production.name],
  );

  // ── production_member: old schema PK is (production_id, open_id) ─────────
  const members: FactoryMember[] = users.map((u) => ({
    productionId: production.id,
    openId: u.openId,
  }));
  for (const m of members) {
    await pool.query(
      `INSERT INTO production_member (production_id, open_id) VALUES ($1, $2)`,
      [m.productionId, m.openId],
    );
  }

  // ── cue_list: created_by is TEXT FK → feishu_user.open_id on old schema ──
  const cueLists: FactoryCueList[] = users.map((u) => ({
    id: `inv-cl-${faker.string.alphanumeric(6).toLowerCase()}`,
    productionId: production.id,
    openId: u.openId,
  }));
  for (const cl of cueLists) {
    await pool.query(
      `INSERT INTO cue_list (id, production_id, name, created_by) VALUES ($1, $2, $3, $4)`,
      [cl.id, cl.productionId, faker.lorem.words(3), cl.openId],
    );
  }

  // ── production_event: created_by TEXT → feishu_user.open_id on old schema ─
  const events: FactoryEvent[] = users.map((u) => ({
    id: `inv-evt-${faker.string.alphanumeric(6).toLowerCase()}`,
    productionId: production.id,
    openId: u.openId,
  }));
  for (const evt of events) {
    await pool.query(
      `INSERT INTO production_event (id, production_id, title, created_by)
       VALUES ($1, $2, $3, $4)`,
      [evt.id, evt.productionId, faker.lorem.sentence(), evt.openId],
    );
  }

  // ── comment: open_id TEXT; mentions [{ openId }] for JSONB invariance ─────
  // Each user's comment mentions the next two users (wrapping), giving a
  // non-trivial JSONB migration path with cross-user references.
  const comments: FactoryComment[] = users.map((u, i) => ({
    id: `inv-cmt-${faker.string.alphanumeric(6).toLowerCase()}`,
    productionId: production.id,
    openId: u.openId,
    mentionOpenIds: [users[(i + 1) % N].openId, users[(i + 2) % N].openId],
  }));
  for (const cmt of comments) {
    const mentions = JSON.stringify(cmt.mentionOpenIds.map((id) => ({ openId: id })));
    await pool.query(
      `INSERT INTO comment
         (id, production_id, context_type, context_id, open_id, author_name, body, mentions)
       VALUES ($1, $2, 'block', 'inv-ctx', $3, $4, $5, $6)`,
      [
        cmt.id,
        cmt.productionId,
        cmt.openId,
        users.find((u) => u.openId === cmt.openId)!.name,
        faker.lorem.sentence(),
        mentions,
      ],
    );
  }

  return { users, production, members, cueLists, events, comments };
}
