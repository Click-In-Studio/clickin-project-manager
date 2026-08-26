/**
 * cue mention 解析锚稳定 cue_id（#302）。
 *
 * 这条测试钉的是 issue 的正题：cue 是修订表，改一次 cue 就 CoW 出新行 id。
 * 引用若锚行 id，改一次就变成 "#[已删除]" 幻影。所以核心用例是
 * 「CoW 之后同一条 mention 仍然解析得出，并且跟到新修订的编号/名字」。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { POST as mentionResolvePOST } from "@/app/api/production/[id]/mention-resolve/route";
import type { ContentMentionAttrs } from "@/lib/mention-types";
import { makeProduction, cleanupProduction, shortId } from "./factories";

let prodId: string;
let versionId: string;
let owner: string;
let cueListId: string;
let abbr: string;
/** 逻辑 cue 身份（= 初版行 id）——正文/边/深链都锚它 */
let cueId: string;
/** 初版修订行 id */
let revision1: string;

const ctx = () => ({ params: Promise.resolve({ id: prodId }) });

function resolveReq(mentions: Partial<ContentMentionAttrs>[], userId = owner) {
  return new NextRequest("http://localhost/api/production/x/mention-resolve", {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      mentions: mentions.map(m => ({ kind: "cue", displayMode: null, aux: null, versionId: null, ...m })),
      versionId,
    }),
  });
}

async function resolveOne(id: string): Promise<{ label: string | null; url: string | null }> {
  const res = await mentionResolvePOST(resolveReq([{ id }]), ctx());
  expect(res.status).toBe(200);
  const data = await res.json() as { labels: (string | null)[]; urls: (string | null)[] };
  return { label: data.labels[0], url: data.urls[0] };
}

/** 模拟一次 CoW：同 cue_id 落新行，把版本归属从旧修订挪到新修订。 */
async function cowRevision(fields: { number: string; name: string }): Promise<string> {
  const newId = `tcue${shortId()}`;
  await getPool().query(
    `INSERT INTO cue (id, cue_id, cue_list_id, number, name, start_kind, end_kind)
     VALUES ($1, $2, $3, $4, $5, 'gap', 'gap')`,
    [newId, cueId, cueListId, fields.number, fields.name],
  );
  await getPool().query("DELETE FROM cue_version WHERE cue_id = $1 AND version_id = $2", [cueId, versionId]);
  await getPool().query(
    "INSERT INTO cue_version (revision_id, version_id, cue_id) VALUES ($1, $2, $3)",
    [newId, versionId, cueId],
  );
  return newId;
}

beforeAll(async () => {
  const u = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  owner = u.rows[0].id;
  ({ prodId, versionId } = await makeProduction(owner));

  cueListId = `t${shortId()}`;
  abbr = `SQ${shortId().slice(0, 3).toUpperCase()}`;
  await getPool().query(
    "INSERT INTO cue_list (id, production_id, name, abbr, notes, created_by) VALUES ($1, $2, 'Q表', $3, '', $4)",
    [cueListId, prodId, abbr, owner],
  );

  cueId = `tcue${shortId()}`;
  revision1 = cueId; // 初版：行 id 与逻辑 id 同值（createCue 就是 VALUES ($1,$1,...)）
  await getPool().query(
    `INSERT INTO cue (id, cue_id, cue_list_id, number, name, start_kind, end_kind)
     VALUES ($1, $1, $2, '1', '开场音', 'gap', 'gap')`,
    [cueId, cueListId],
  );
  await getPool().query(
    "INSERT INTO cue_version (revision_id, version_id, cue_id) VALUES ($1, $2, $1)",
    [cueId, versionId],
  );
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = $1", [owner]).catch(() => {});
});

describe("cue mention resolve", () => {
  it("resolves a cue mention to 编号 + 名字, linking by stable cue_id", async () => {
    const { label, url } = await resolveOne(cueId);
    expect(label).toBe(`${abbr}.1: 开场音`);
    expect(url).toContain(`cueList=${cueListId}`);
    expect(url).toContain(`cueId=${cueId}`);
  });

  it("survives a CoW revision and follows the new revision's fields", async () => {
    // 这就是 #302 的正题：换过修订之后，同一条 mention 不许变成 "#[已删除]"。
    const revision2 = await cowRevision({ number: "2", name: "追光" });
    expect(revision2).not.toBe(revision1);

    const { label, url } = await resolveOne(cueId);
    expect(label).toBe(`${abbr}.2: 追光`);
    expect(url).toContain(`cueId=${cueId}`);
  });

  it("a mention anchored on a revision row id resolves to nothing", async () => {
    // 反证：锚行 id 的旧式引用查不到。这条钉的是"锚的确实是 cue_id 而不是行 id"——
    // 若哪天解析退回按 id 查，它会变绿。
    const revision3 = await cowRevision({ number: "3", name: "暗场" });
    const { label } = await resolveOne(revision3);
    expect(label).toBe("#[已删除]");
  });

  it("does not resolve a cue belonging to another production", async () => {
    const other = await makeProduction(owner);
    try {
      const otherListId = `t${shortId()}`;
      const otherCueId = `tcue${shortId()}`;
      await getPool().query(
        "INSERT INTO cue_list (id, production_id, name, abbr, notes, created_by) VALUES ($1, $2, 'Q表', 'ZZ', '', $3)",
        [otherListId, other.prodId, owner],
      );
      await getPool().query(
        `INSERT INTO cue (id, cue_id, cue_list_id, number, name, start_kind, end_kind)
         VALUES ($1, $1, $2, '9', '外剧组', 'gap', 'gap')`,
        [otherCueId, otherListId],
      );
      const { label } = await resolveOne(otherCueId);
      expect(label).toBe("#[已删除]");
    } finally {
      await cleanupProduction(other.prodId).catch(() => {});
    }
  });
});
