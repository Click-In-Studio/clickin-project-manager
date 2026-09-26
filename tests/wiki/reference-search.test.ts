import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { createWiki } from "@/lib/wiki/content";
import { createAsset } from "@/lib/asset/db";
import { insertNode } from "@/lib/node/db";
import { createCue } from "@/lib/ops/cue-db";
import { createCueList } from "@/lib/ops/cue-list-db";
import { GET as referenceSearchGET } from "@/app/api/production/[id]/reference-search/route";
import {
  cleanupProduction,
  makeProduction,
  makeScene,
  shortId,
} from "../_support/factories";
import type { ReferenceSearchResult } from "@/lib/editor/reference-search-types";

let prodId: string;
let versionId: string;
let owner: string;
let member: string;
let outsider: string;
let wikiId: string;
let sceneId: string;
let imageAssetId: string;
let pdfAssetId: string;
let cueId: string;
const users: string[] = [];

async function newUser(): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    "INSERT INTO app_user DEFAULT VALUES RETURNING id",
  );
  users.push(rows[0].id);
  return rows[0].id;
}

function cookie(userId: string): string {
  return `${SESSION_COOKIE}=${createSession({
    userId, name: "测试", avatarUrl: null, isAdmin: false,
  })}`;
}

const ctx = () => ({ params: Promise.resolve({ id: prodId }) });

async function search(
  kind: string,
  q: string,
  userId: string | null = owner,
  embeddable = false,
): Promise<{ status: number; results: ReferenceSearchResult[] }> {
  const params = new URLSearchParams({ kind, q });
  if (embeddable) params.set("embeddable", "1");
  const req = new NextRequest(
    `http://localhost/api/production/${prodId}/reference-search?${params}`,
    userId ? { headers: { cookie: cookie(userId) } } : undefined,
  );
  const res = await referenceSearchGET(req, ctx());
  const data = await res.json() as { results?: ReferenceSearchResult[] };
  return { status: res.status, results: data.results ?? [] };
}

beforeAll(async () => {
  owner = await newUser();
  member = await newUser();
  outsider = await newUser();
  ({ prodId, versionId } = await makeProduction(owner));
  await getPool().query(
    "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')",
    [prodId, member],
  );
  // 只持一枚不够用的 meta 键：scene 搜索必须认 blocks@view，不能拿粗门放行。
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'script', '*', 'meta', 'view', 'direct')`,
    [prodId, member],
  );

  const wiki = await createWiki({
    productionId: prodId,
    title: "灯光设计说明",
    body: "舞台灯光",
    createdBy: owner,
    listable: false,
  });
  wikiId = wiki.id;
  sceneId = await makeScene(prodId, versionId, { number: "2-3", name: "码头夜戏" });

  const folderId = await insertNode({
    productionId: prodId,
    kind: "folder",
    parentId: null,
    sortKey: null,
    title: "交付区",
    listable: false,
    createdBy: owner,
  });
  imageAssetId = (await createAsset({
    productionId: prodId,
    uploaderUserId: owner,
    assetType: "drafting",
    name: "舞台总图",
    fileName: "stage.png",
    mimeType: "image/png",
    storageType: "r2",
    nodeParentId: folderId,
  })).asset.id;
  pdfAssetId = (await createAsset({
    productionId: prodId,
    uploaderUserId: owner,
    assetType: "reference",
    name: "施工手册",
    fileName: "manual.pdf",
    mimeType: "application/pdf",
    storageType: "r2",
    nodeParentId: folderId,
  })).asset.id;

  const cueListId = `cl_${shortId()}`;
  await createCueList({
    id: cueListId,
    productionId: prodId,
    name: "灯光 Cue 表",
    notes: "",
    abbr: "LX",
    template: null,
    createdBy: owner,
  });
  cueId = `cue_${shortId()}`;
  await createCue({
    id: cueId,
    cueListId,
    number: "12",
    name: "月光渐亮",
    content: "",
    start: { kind: "gap", afterBlockId: null },
    end: { kind: "gap", afterBlockId: null },
    versionId,
  });
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1)", [users]).catch(() => {});
});

describe("GET reference-search 权限门", () => {
  it("未登录 401、非成员 403", async () => {
    expect((await search("wiki", "灯光", null)).status).toBe(401);
    expect((await search("wiki", "灯光", outsider)).status).toBe(403);
  });

  it("只持 script meta@view 仍不能搜场次", async () => {
    expect((await search("scene", "码头", member)).status).toBe(403);
  });

  it("未知类型 400", async () => {
    expect((await search("task", "灯光")).status).toBe(400);
  });
});

describe("GET reference-search 各类型", () => {
  it("文档按标题或正文搜索，返回既有 wiki id", async () => {
    const found = await search("wiki", "灯光");
    expect(found.status).toBe(200);
    expect(found.results).toContainEqual({ kind: "wiki", id: wikiId, label: "灯光设计说明" });
  });

  it("素材按名字、文件名或文件夹搜索；嵌入模式只留媒体", async () => {
    const all = await search("asset", "交付区");
    expect(new Set(all.results.map(result => result.id))).toEqual(new Set([imageAssetId, pdfAssetId]));
    expect(all.results.every(result => result.description?.includes("交付区"))).toBe(true);

    const embeddable = await search("asset", "交付区", owner, true);
    expect(embeddable.results.map(result => result.id)).toEqual([imageAssetId]);
  });

  it("场次按场号或场名搜索", async () => {
    const found = await search("scene", "码头");
    const scene = found.results.find(result => result.id === sceneId);
    expect(scene?.kind).toBe("scene");
    expect(scene?.label).toContain("码头夜戏");
    const number = scene?.label.match(/^#(\S+)/)?.[1];
    expect(number).toBeTruthy();
    expect((await search("scene", number!)).results.map(result => result.id)).toContain(sceneId);
  });

  it("Cue 按简称编号、名字或所属表搜索，正文锚稳定 cue_id", async () => {
    const byName = await search("cue", "月光");
    expect(byName.results).toContainEqual({
      kind: "cue",
      id: cueId,
      label: "#LX.12 · 月光渐亮",
      description: "灯光 Cue 表",
    });
    expect((await search("cue", "LX.12")).results.map(result => result.id)).toContain(cueId);
  });

  it("没有各域可见行的成员搜不到文档、素材和 Cue", async () => {
    expect((await search("wiki", "灯光", member)).results).toEqual([]);
    expect((await search("asset", "交付区", member)).results).toEqual([]);
    expect((await search("cue", "月光", member)).results).toEqual([]);
  });
});
