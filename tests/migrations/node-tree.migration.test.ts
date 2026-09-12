/**
 * migrate-node-tree.sql 三层验证（epic #420 第一批）。
 *
 * Migration path (CI)：global-setup 检测旧 schema（wiki.parent_id 存在）→ 裸 SQL
 * 造工厂数据 → 写快照 → 应用 add-node-tree.sql + migrate-node-tree.sql。
 * Normal path (本地已迁库)：快照不存在，invariance 层跳过，schema/integrity 照跑。
 *
 * 层 1 schema：新表列型/约束到位，旧表旧列消失。
 * 层 2 integrity：wiki/asset ↔ node 1:1、退役 mount 词汇零残留、树无跨剧组、link 无子。
 * 层 3 invariance：树列逐值保真、alias→link、folder 链展开、mount 值转译、
 *   report/note/锚点回映、grant 行逐字节未动、幂等重放。
 */
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { getPool } from "@/lib/pg";
import {
  NODE_TREE_SNAPSHOT_PATH,
  type NodeTreeSnapshot,
} from "./node-tree-snapshot";

let snapshot: NodeTreeSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(NODE_TREE_SNAPSHOT_PATH, "utf8"));
} catch {
  snapshot = null;
}

const ndid = (src: string): string =>
  "nd_" + createHash("md5").update(src).digest("hex").slice(0, 14);

async function columns(table: string): Promise<Map<string, { type: string; nullable: string }>> {
  const { rows } = await getPool().query<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Map(rows.map(r => [r.column_name, { type: r.data_type, nullable: r.is_nullable }]));
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await getPool().query(`SELECT to_regclass('public.' || $1) AS t`, [name]);
  return rows[0].t !== null;
}

describe("schema verification", () => {
  it("node：列型与目标三列/权限位齐备", async () => {
    const c = await columns("node");
    expect(c.get("id")?.type).toBe("text");
    expect(c.get("kind")?.nullable).toBe("NO");
    expect(c.get("parent_id")?.type).toBe("text");
    expect(c.get("wiki_id")?.type).toBe("uuid");
    expect(c.get("asset_id")?.type).toBe("text");
    expect(c.get("link_target_id")?.type).toBe("text");
    expect(c.get("is_public")?.nullable).toBe("NO");
    expect(c.get("listable")?.nullable).toBe("NO");
  });

  it("node 的 CHECK / 唯一索引存在", async () => {
    const { rows } = await getPool().query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname IN ('node_kind_target_check', 'node_link_no_perm_check')`,
    );
    expect(rows.map(r => r.conname).sort()).toEqual(["node_kind_target_check", "node_link_no_perm_check"]);
    const { rows: idx } = await getPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname IN ('node_wiki_uidx', 'node_asset_uidx', 'node_link_place_uidx')`,
    );
    expect(idx).toHaveLength(3);
  });

  it("wiki 回归纯文档：四树列消失", async () => {
    const c = await columns("wiki");
    for (const col of ["parent_id", "sort_key", "is_public", "listable"]) {
      expect(c.has(col), `wiki.${col} 应已删除`).toBe(false);
    }
    expect(c.has("body")).toBe(true);
  });

  it("asset.is_public 消失（迁入 node）", async () => {
    expect((await columns("asset")).has("is_public")).toBe(false);
  });

  it("node_mount：换键完成、化石列消失、CHECK 白名单在位", async () => {
    expect(await tableExists("asset_mount")).toBe(false);
    const c = await columns("node_mount");
    expect(c.get("node_id")?.nullable).toBe("NO");
    for (const col of ["asset_id", "folder_path", "mount_mode", "version_resolved"]) {
      expect(c.has(col), `node_mount.${col} 应已删除`).toBe(false);
    }
    expect(c.has("mount_aux_id")).toBe(true);
    const { rows } = await getPool().query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'node_mount_type_check'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("report/note 边换键：node_id NOT NULL、wiki_id 消失", async () => {
    const er = await columns("event_report");
    expect(er.get("node_id")?.nullable).toBe("NO");
    expect(er.has("wiki_id")).toBe(false);
    const ern = await columns("event_report_note");
    expect(ern.get("node_id")?.nullable).toBe("NO");
    expect(ern.has("wiki_id")).toBe(false);
  });

  it("config 改名 + 三根列换 node id；旧根列消失", async () => {
    expect(await tableExists("production_wiki_config")).toBe(false);
    const c = await columns("production_node_config");
    for (const col of ["reports_root_node_id", "dramaturgy_root_node_id", "assets_root_node_id"]) {
      expect(c.get(col)?.type, col).toBe("text");
    }
    expect(c.has("reports_root_wiki_id")).toBe(false);
    expect(c.has("dramaturgy_root_wiki_id")).toBe(false);
    expect((await columns("production_event")).has("report_doc_wiki_id")).toBe(false);
    expect((await columns("production_event")).get("report_doc_node_id")?.type).toBe("text");
    expect((await columns("wiki_proposal")).has("parent_wiki_id")).toBe(false);
    expect((await columns("wiki_proposal")).get("parent_node_id")?.type).toBe("text");
  });

  it("退役表消失、备份表在位", async () => {
    expect(await tableExists("wiki_alias")).toBe(false);
    expect(await tableExists("wiki_dept_share")).toBe(false);
    expect(await tableExists("asset_share_token")).toBe(false);
    expect(await tableExists("wiki_alias_backup_node_tree")).toBe(true);
    expect(await tableExists("wiki_tree_backup_node_tree")).toBe(true);
    expect(await tableExists("node_dept_share")).toBe(true);
  });
});

describe("integrity verification", () => {
  it("每个 wiki 恰有一个 node；每个 asset 恰有一个 node", async () => {
    const { rows: w } = await getPool().query(
      `SELECT w.id FROM wiki w LEFT JOIN node n ON n.wiki_id = w.id
       GROUP BY w.id HAVING COUNT(n.id) <> 1 LIMIT 5`,
    );
    expect(w).toHaveLength(0);
    const { rows: a } = await getPool().query(
      `SELECT a.id FROM asset a LEFT JOIN node n ON n.asset_id = a.id
       GROUP BY a.id HAVING COUNT(n.id) <> 1 LIMIT 5`,
    );
    expect(a).toHaveLength(0);
  });

  it("退役 mount_type 词汇零残留", async () => {
    const { rows } = await getPool().query(
      `SELECT DISTINCT mount_type FROM node_mount
       WHERE mount_type IN ('production', 'wiki', 'version', 'scene_snapshot', 'block_snapshot', 'cue_revision')`,
    );
    expect(rows).toHaveLength(0);
  });

  it("树无跨剧组父链；link 是叶子", async () => {
    const { rows: cross } = await getPool().query(
      `SELECT c.id FROM node c JOIN node p ON p.id = c.parent_id
       WHERE c.production_id <> p.production_id LIMIT 5`,
    );
    expect(cross).toHaveLength(0);
    const { rows: linkKids } = await getPool().query(
      `SELECT c.id FROM node c JOIN node p ON p.id = c.parent_id WHERE p.kind = 'link' LIMIT 5`,
    );
    expect(linkKids).toHaveLength(0);
  });

  it("config 三根列全部解析到 node", async () => {
    const { rows } = await getPool().query(
      `SELECT c.production_id FROM production_node_config c
       WHERE (c.reports_root_node_id    IS NOT NULL AND NOT EXISTS (SELECT 1 FROM node n WHERE n.id = c.reports_root_node_id))
          OR (c.dramaturgy_root_node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM node n WHERE n.id = c.dramaturgy_root_node_id))
          OR (c.assets_root_node_id     IS NOT NULL AND NOT EXISTS (SELECT 1 FROM node n WHERE n.id = c.assets_root_node_id))
       LIMIT 5`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("invariance verification", () => {
  const s = () => snapshot!;

  it.skipIf(!snapshot)("wiki 树列逐值保真迁入 node（parent 链翻译成 node id）", async () => {
    const { rows } = await getPool().query(
      `SELECT id, parent_id, sort_key, is_public, listable, kind FROM node WHERE wiki_id = ANY($1::uuid[]) ORDER BY sort_key`,
      [[s().wikiA, s().wikiB, s().wikiC]],
    );
    expect(rows).toHaveLength(3);
    const [na, nb, nc] = rows;
    expect(na.id).toBe(ndid(`wiki:${s().wikiA}`));
    expect([na.parent_id, na.sort_key, na.is_public, na.listable]).toEqual([null, s().sortA, true, true]);
    expect([nb.parent_id, nb.sort_key, nb.is_public, nb.listable]).toEqual([na.id, s().sortB, false, false]);
    expect([nc.parent_id, nc.sort_key, nc.is_public, nc.listable]).toEqual([nb.id, s().sortC, false, true]);
  });

  it.skipIf(!snapshot)("alias → kind='link' 节点（位置/显示名/目标保真）", async () => {
    const { rows: [l] } = await getPool().query(
      `SELECT * FROM node WHERE id = $1`, [ndid(`alias:${s().aliasId}`)],
    );
    expect(l).toBeTruthy();
    expect(l.kind).toBe("link");
    expect(l.parent_id).toBe(ndid(`wiki:${s().wikiA}`));
    expect(l.link_target_id).toBe(ndid(`wiki:${s().wikiC}`));
    expect(l.sort_key).toBe(s().aliasSort);
    expect(l.title).toBe(s().aliasTitle);
  });

  it.skipIf(!snapshot)("dept_share 落到 node_dept_share", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM node_dept_share WHERE node_id = $1 AND dept_id = $2::uuid`,
      [ndid(`wiki:${s().wikiB}`), s().deptId],
    );
    expect(rows).toHaveLength(1);
  });

  it.skipIf(!snapshot)("folder_path 展开为链；A1 落「资产根→设计→平面图」且 listable", async () => {
    const root = ndid(`assets-root:${s().prodId}`);
    const f1 = ndid(`folder:${s().prodId}:/设计`);
    const f2 = ndid(`folder:${s().prodId}:/设计/平面图`);
    const { rows: folders } = await getPool().query(
      `SELECT id, parent_id, kind, title, listable FROM node WHERE id = ANY($1) ORDER BY id`,
      [[root, f1, f2].sort()],
    );
    expect(folders).toHaveLength(3);
    const byId = new Map(folders.map(f => [f.id, f]));
    expect(byId.get(root)?.parent_id).toBeNull();
    expect(byId.get(root)?.title).toBe("资产");
    expect(byId.get(f1)?.parent_id).toBe(root);
    expect(byId.get(f2)?.parent_id).toBe(f1);
    expect(byId.get(f2)?.title).toBe("平面图");
    const { rows: [n1] } = await getPool().query(
      `SELECT parent_id, listable FROM node WHERE asset_id = $1`, [s().a1],
    );
    expect(n1.parent_id).toBe(f2);
    expect(n1.listable).toBe(true);
  });

  it.skipIf(!snapshot)("A2 落资产根 listable；A3 无挂载 → 资产根但不可枚举（隐私保真）", async () => {
    const root = ndid(`assets-root:${s().prodId}`);
    const { rows: [n2] } = await getPool().query(
      `SELECT parent_id, listable FROM node WHERE asset_id = $1`, [s().a2]);
    expect([n2.parent_id, n2.listable]).toEqual([root, true]);
    const { rows: [n3] } = await getPool().query(
      `SELECT parent_id, listable FROM node WHERE asset_id = $1`, [s().a3]);
    expect([n3.parent_id, n3.listable]).toEqual([root, false]);
  });

  it.skipIf(!snapshot)("A8 双目录：canonical 取最早，另一目录生成 link；is_public 迁入 node", async () => {
    const f2 = ndid(`folder:${s().prodId}:/设计/平面图`);
    const f3 = ndid(`folder:${s().prodId}:/${s().a8Folder2}`);
    const an = ndid(`asset:${s().a8}`);
    const { rows: [n8] } = await getPool().query(
      `SELECT parent_id, is_public FROM node WHERE id = $1`, [an]);
    expect(n8.parent_id).toBe(f2);
    expect(n8.is_public).toBe(true);
    const { rows: links } = await getPool().query(
      `SELECT 1 FROM node WHERE kind = 'link' AND parent_id = $1 AND link_target_id = $2`, [f3, an]);
    expect(links).toHaveLength(1);
  });

  it.skipIf(!snapshot)("mount 转译：block_snapshot→block 稳定 id、cue_revision→cue 稳定 id", async () => {
    const { rows: [m4] } = await getPool().query(
      `SELECT mount_type, mount_id FROM node_mount WHERE node_id = $1`, [ndid(`asset:${s().a4}`)]);
    expect([m4.mount_type, m4.mount_id]).toEqual(["block", s().blockStableId]);
    const { rows: [m5] } = await getPool().query(
      `SELECT mount_type, mount_id FROM node_mount WHERE node_id = $1`, [ndid(`asset:${s().a5}`)]);
    expect([m5.mount_type, m5.mount_id]).toEqual(["cue", s().cueStableId]);
  });

  it.skipIf(!snapshot)("wiki mount → embed（宿主仍是 wiki uuid）；化石与 production mount 消失", async () => {
    const { rows: [m6] } = await getPool().query(
      `SELECT mount_type, mount_id FROM node_mount WHERE node_id = $1`, [ndid(`asset:${s().a6}`)]);
    expect([m6.mount_type, m6.mount_id]).toEqual(["embed", s().wikiA]);
    const { rows: m7 } = await getPool().query(
      `SELECT 1 FROM node_mount WHERE node_id = $1`, [ndid(`asset:${s().a7}`)]);
    expect(m7).toHaveLength(0);
    const { rows: m1 } = await getPool().query(
      `SELECT 1 FROM node_mount WHERE node_id = $1`, [ndid(`asset:${s().a1}`)]);
    expect(m1).toHaveLength(0);
  });

  it.skipIf(!snapshot)("report/note 边回映原 wiki；note 节点 parent = 报告文档节点", async () => {
    const { rows: [er] } = await getPool().query(
      `SELECT node_id FROM event_report WHERE id = $1`, [s().reportId]);
    expect(er.node_id).toBe(ndid(`wiki:${s().reportWiki}`));
    const { rows: [rn] } = await getPool().query(
      `SELECT node_id FROM event_report_note WHERE id = $1`, [s().noteId]);
    expect(rn.node_id).toBe(ndid(`wiki:${s().noteWiki}`));
    const { rows: [noteNode] } = await getPool().query(
      `SELECT parent_id FROM node WHERE id = $1`, [ndid(`wiki:${s().noteWiki}`)]);
    expect(noteNode.parent_id).toBe(ndid(`wiki:${s().reportWiki}`));
  });

  it.skipIf(!snapshot)("锚点三处回映：config 两根 + event 目录 + 资产根", async () => {
    const { rows: [c] } = await getPool().query(
      `SELECT reports_root_node_id, dramaturgy_root_node_id, assets_root_node_id
       FROM production_node_config WHERE production_id = $1`, [s().prodId]);
    expect(c.reports_root_node_id).toBe(ndid(`wiki:${s().reportsRootWiki}`));
    expect(c.dramaturgy_root_node_id).toBe(ndid(`wiki:${s().dramaturgyRootWiki}`));
    expect(c.assets_root_node_id).toBe(ndid(`assets-root:${s().prodId}`));
    const { rows: [e] } = await getPool().query(
      `SELECT report_doc_node_id FROM production_event WHERE id = $1`, [s().eventId]);
    expect(e.report_doc_node_id).toBe(ndid(`wiki:${s().eventDocWiki}`));
  });

  it.skipIf(!snapshot)("grant 行逐字节未动（wiki/asset 内容域键零迁移）", async () => {
    const { rows } = await getPool().query(
      `SELECT resource_type, resource_id, resource_sub, permission_level
       FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2::uuid AND NOT is_revoked
       ORDER BY resource_type`,
      [s().prodId, s().u2Id],
    );
    expect(rows).toEqual([
      { resource_type: "asset", resource_id: s().a3, resource_sub: "meta", permission_level: "view" },
      { resource_type: "wiki", resource_id: s().wikiC, resource_sub: "meta", permission_level: "view" },
    ]);
  });

  it.skipIf(!snapshot)("幂等重放：再跑一遍迁移 SQL，node/node_mount 行数不变", async () => {
    const before = await getPool().query(
      `SELECT (SELECT COUNT(*) FROM node) AS n, (SELECT COUNT(*) FROM node_mount) AS m`);
    const sql = readFileSync("db/migrate-node-tree.sql", "utf8");
    await getPool().query(sql);
    const after = await getPool().query(
      `SELECT (SELECT COUNT(*) FROM node) AS n, (SELECT COUNT(*) FROM node_mount) AS m`);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

afterAll(async () => {
  // 快照数据由 global-setup teardown 统一清理（production CASCADE）
});
