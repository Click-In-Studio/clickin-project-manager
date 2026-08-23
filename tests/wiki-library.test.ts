import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { WIKI_LEVEL_ROW_SETS, writeWikiGrants } from "@/lib/resource-grant-db";
import { TYPE_LABELS } from "@/lib/permission-labels";
import { PAGE_PERMISSION_SCOPES } from "@/lib/page-permission-scopes";
import { mergeAccounts } from "@/lib/db";
import { makeProduction, cleanupProduction } from "./factories";

// wiki 文档库 W1+W2：schema 与权限面（设计账本：MindWeave《wiki文档库-现状调研与实施路线》§4/§5）

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

let prodId: string;
let creator: string;
let wikiId: string;
const extraUsers: string[] = [];

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  creator = await newUser();
  extraUsers.push(creator);
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO wiki (production_id, title, body, created_by) VALUES ($1, '独立文档', '正文', $2) RETURNING id`,
    [prodId, creator],
  );
  wikiId = res.rows[0].id;
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1)", [extraUsers]).catch(() => {});
});

describe("W1 schema", () => {
  it("wiki has tree/visibility columns (parent_id, sort_key, is_public)", async () => {
    const res = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'wiki'`,
    );
    const cols = res.rows.map(r => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(["parent_id", "sort_key", "is_public"]));
  });

  it("wiki_entity_link / wiki_tag / wiki_dept_share / wiki_revision tables exist", async () => {
    const res = await getPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name IN ('wiki_entity_link', 'wiki_tag', 'wiki_dept_share', 'wiki_revision')`,
    );
    expect(res.rows.map(r => r.table_name).sort()).toEqual(
      ["wiki_dept_share", "wiki_entity_link", "wiki_revision", "wiki_tag"],
    );
  });

  it("new wiki defaults to private (is_public = false)", async () => {
    const res = await getPool().query<{ is_public: boolean }>(
      `SELECT is_public FROM wiki WHERE id = $1`, [wikiId],
    );
    expect(res.rows[0].is_public).toBe(false);
  });

  it("deleting a parent promotes children to root (ON DELETE SET NULL)", async () => {
    const parent = await getPool().query<{ id: string }>(
      `INSERT INTO wiki (production_id, title) VALUES ($1, '父') RETURNING id`, [prodId]);
    const child = await getPool().query<{ id: string }>(
      `INSERT INTO wiki (production_id, title, parent_id) VALUES ($1, '子', $2) RETURNING id`,
      [prodId, parent.rows[0].id]);
    await getPool().query(`DELETE FROM wiki WHERE id = $1`, [parent.rows[0].id]);
    const res = await getPool().query<{ parent_id: string | null }>(
      `SELECT parent_id FROM wiki WHERE id = $1`, [child.rows[0].id]);
    expect(res.rows[0].parent_id).toBeNull();
  });
});

describe("W2 permission plane", () => {
  it("resource_permission_level has wiki four verbs", async () => {
    const res = await getPool().query<{ permission_level: string }>(
      `SELECT permission_level FROM resource_permission_level WHERE resource_type = 'wiki' ORDER BY permission_level`,
    );
    expect(res.rows.map(r => r.permission_level)).toEqual(["create", "delete", "edit", "view"]);
  });

  it("row sets are monotonic (view ⊂ edit ⊂ manage) and manage carries grants@edit", () => {
    const key = (r: readonly [string, string]) => r.join("@");
    const view = WIKI_LEVEL_ROW_SETS.view.map(key);
    const edit = WIKI_LEVEL_ROW_SETS.edit.map(key);
    const manage = WIKI_LEVEL_ROW_SETS.manage.map(key);
    for (const r of view) expect(edit).toContain(r);
    for (const r of edit) expect(manage).toContain(r);
    expect(manage).toContain("grants@edit");
    expect(view).toContain("meta@view");
  });

  it("writeWikiGrants gives creator the manage row set + person 归属", async () => {
    await writeWikiGrants(wikiId, prodId, creator);
    const rows = await getPool().query<{ resource_sub: string; permission_level: string }>(
      `SELECT resource_sub, permission_level FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2 AND resource_type = 'wiki' AND resource_id = $3
         AND NOT is_revoked`,
      [prodId, creator, wikiId],
    );
    const got = rows.rows.map(r => `${r.resource_sub}@${r.permission_level}`).sort();
    const want = WIKI_LEVEL_ROW_SETS.manage.map(([s, v]) => `${s}@${v}`).sort();
    expect(got).toEqual(want);

    const person = await getPool().query(
      `SELECT 1 FROM resource_person_manage
       WHERE production_id = $1 AND user_id = $2 AND resource_type = 'wiki' AND resource_id = $3`,
      [prodId, creator, wikiId],
    );
    expect(person.rows.length).toBe(1);
  });

  it("TYPE_LABELS and page scopes cover wiki", () => {
    expect(TYPE_LABELS.wiki).toBeTruthy();
    expect(PAGE_PERMISSION_SCOPES.wiki.has("node:wiki/*@create")).toBe(true);
  });
});

describe("mergeAccounts covers wiki_revision", () => {
  it("transfers revision authorship before deleting the old user", async () => {
    const keep = await newUser();
    const del = await newUser();
    extraUsers.push(keep);
    await getPool().query(
      `INSERT INTO wiki_revision (wiki_id, body, author_user_id) VALUES ($1, '旧版本', $2)`,
      [wikiId, del],
    );
    await mergeAccounts(keep, del);
    const res = await getPool().query<{ author_user_id: string }>(
      `SELECT author_user_id FROM wiki_revision WHERE wiki_id = $1 AND body = '旧版本'`,
      [wikiId],
    );
    expect(res.rows[0].author_user_id).toBe(keep);
  });
});
