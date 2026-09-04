/**
 * Snapshot plumbing for migrate-node-tree.sql（epic #420 第一批）。
 *
 * Pre-migration detection: wiki 表仍有 parent_id 列（与迁移 SQL 的总闸同判据）。
 * Factory data（global-setup 在应用迁移前于**旧 schema** 上裸 SQL 造出）：
 *   - wiki 树 A(根,listable,public) → B(listable=false,dept_share=D) → C(listable)
 *     + U2 持 wiki/C meta@view 行（迁移后 grant 行必须逐字节原样）
 *   - 软链接 AL: parent=A → target=C, display_title 定制
 *   - 报告链全套：config(reports_root=R) + event E(report_doc=ED) + report ER(wiki
 *     RW 挂 ED 下) + note NW(dept=D, parent=RW)——覆盖 event-db 手写 sort_key 直插路径
 *   - 灵感库根 DW（config.dramaturgy_root）
 *   - 资产 A1..A8：production+folder / production 无 folder / 无挂载私有(U2 实例票) /
 *     block_snapshot(带 script_version 映射行) / cue_revision(带 cue 行稳定 id) /
 *     wiki mount(→A) / version+scene_snapshot 化石 / 双 folder_path
 *   - asset_share_token 一行（迁移应删表）
 * 每个 asset 补 resource_person_manage 行（asset 域完整性不变量，见
 * task-standalone-snapshot 同款注释）。
 */
import type { Pool } from "pg";
import path from "path";

export const NODE_TREE_SNAPSHOT_PATH = path.resolve(
  process.cwd(),
  "tests/.node-tree-snapshot.json",
);

export type NodeTreeSnapshot = {
  prodId: string;
  userId: string;
  u2Id: string;
  deptId: string;
  // wiki 树
  wikiA: string; wikiB: string; wikiC: string;
  sortA: string; sortB: string; sortC: string;
  aliasId: string; aliasSort: string; aliasTitle: string;
  // 报告链
  reportsRootWiki: string; eventId: string; eventDocWiki: string;
  reportId: string; reportWiki: string; noteId: string; noteWiki: string;
  dramaturgyRootWiki: string;
  // 资产
  a1: string; a2: string; a3: string; a4: string; a5: string; a6: string; a7: string; a8: string;
  a1MountCreatedBy: string;
  blockSnapshotId: string; blockStableId: string;
  cueRevisionRowId: string; cueStableId: string;
  a8Folder2: string;
};

export async function isNodeTreePreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'wiki' AND column_name = 'parent_id'`,
  );
  return rows.length > 0;
}

export async function createNodeTreePreMigrationData(
  pool: Pool,
  userId: string,
): Promise<NodeTreeSnapshot> {
  const prodId = "ndtrmig1";
  await pool.query(
    `INSERT INTO production (id, name, owner_id) VALUES ($1, 'node树迁移工厂', $2)
     ON CONFLICT (id) DO NOTHING`,
    [prodId, userId],
  );
  await pool.query(
    `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')
     ON CONFLICT DO NOTHING`,
    [prodId, userId],
  );
  // 主本随建（script-view 迁移的 integrity 断言要求每个演出都有主本；本块排在
  // 那支迁移之后，裸 production 不会再被它回填——role-drift 工厂同款）
  await pool.query(
    `INSERT INTO script_view (id, production_id, name) VALUES ('svndtrmig1', $1, '标准本')
     ON CONFLICT DO NOTHING`,
    [prodId],
  );
  await pool.query(
    `UPDATE production SET master_view_id = 'svndtrmig1' WHERE id = $1 AND master_view_id IS NULL`,
    [prodId],
  );
  const { rows: [{ id: u2Id }] } = await pool.query<{ id: string }>(
    `INSERT INTO app_user DEFAULT VALUES RETURNING id::text AS id`,
  );
  await pool.query(
    `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2::uuid, '{}')
     ON CONFLICT DO NOTHING`,
    [prodId, u2Id],
  );
  const { rows: [{ id: deptId }] } = await pool.query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, 'node迁移部门') RETURNING id::text AS id`,
    [prodId],
  );

  // ── wiki 树 A → B → C（树列/权限位逐值保真是 invariance 主断言）─────────────
  const mkWiki = async (
    title: string | null, parentId: string | null, sortKey: string | null,
    isPublic: boolean, listable: boolean,
  ): Promise<string> => {
    const { rows: [{ id }] } = await pool.query<{ id: string }>(
      `INSERT INTO wiki (production_id, title, body, created_by, parent_id, sort_key, is_public, listable)
       VALUES ($1, $2, '', $3::uuid, $4::uuid, $5, $6, $7) RETURNING id::text AS id`,
      [prodId, title, userId, parentId, sortKey, isPublic, listable],
    );
    return id;
  };
  const sortA = "aaaaaaaaaa", sortB = "bbbbbbbbbb", sortC = "cccccccccc", aliasSort = "dddddddddd";
  const wikiA = await mkWiki("迁移A根", null, sortA, true, true);
  const wikiB = await mkWiki("迁移B私", wikiA, sortB, false, false);
  const wikiC = await mkWiki("迁移C叶", wikiB, sortC, false, true);
  await pool.query(
    `INSERT INTO wiki_dept_share (wiki_id, dept_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`,
    [wikiB, deptId],
  );
  await pool.query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
     VALUES ($1, $2::uuid, 'wiki', $3, 'meta', 'view', 'direct', $2::uuid)
     ON CONFLICT DO NOTHING`,
    [prodId, u2Id, wikiC],
  );
  const aliasId = "wal_ndtrmig1";
  const aliasTitle = "迁移别名X";
  await pool.query(
    `INSERT INTO wiki_alias (id, production_id, parent_id, sort_key, target_type, target_id, display_title, created_by)
     VALUES ($1, $2, $3::uuid, $4, 'wiki', $5, $6, $7::uuid) ON CONFLICT DO NOTHING`,
    [aliasId, prodId, wikiA, aliasSort, wikiC, aliasTitle, userId],
  );

  // ── 报告链（root/事件目录锚点 + report/note 边，note 走旧世界的手写落位形态）──
  const reportsRootWiki = await mkWiki("报告", null, "rrrrrrrrrr", true, true);
  const dramaturgyRootWiki = await mkWiki("戏剧构作", null, "ssssssssss", true, true);
  await pool.query(
    `INSERT INTO production_wiki_config (production_id, reports_root_wiki_id, dramaturgy_root_wiki_id)
     VALUES ($1, $2::uuid, $3::uuid)
     ON CONFLICT (production_id) DO UPDATE
       SET reports_root_wiki_id = EXCLUDED.reports_root_wiki_id,
           dramaturgy_root_wiki_id = EXCLUDED.dramaturgy_root_wiki_id`,
    [prodId, reportsRootWiki, dramaturgyRootWiki],
  );
  const eventId = "evndtrmig1";
  const eventDocWiki = await mkWiki("迁移事件目录", reportsRootWiki, "tttttttttt", true, true);
  await pool.query(
    `INSERT INTO production_event (id, production_id, title, created_by, status, start_time, end_time, report_doc_wiki_id)
     VALUES ($1, $2, 'node迁移事件', $3::uuid, 'published', '2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z', $4::uuid)`,
    [eventId, prodId, userId, eventDocWiki],
  );
  const reportWiki = await mkWiki("迁移报告文档", eventDocWiki, "uuuuuuuuuu", false, true);
  const reportId = "erndtrmig1";
  await pool.query(
    `INSERT INTO event_report (id, event_id, report_type, wiki_id) VALUES ($1, $2, 'rehearsal', $3::uuid)`,
    [reportId, eventId, reportWiki],
  );
  const noteWiki = await mkWiki(null, reportWiki, "vvvvvvvvvv", false, true); // note wiki：title NULL
  const noteId = "ernndtrmig1";
  await pool.query(
    `INSERT INTO event_report_note (id, report_id, department_id, wiki_id, created_via)
     VALUES ($1, $2, $3::uuid, $4::uuid, 'dept')`,
    [noteId, reportId, deptId, noteWiki],
  );

  // ── 资产 ──────────────────────────────────────────────────────────────────
  const mkAsset = async (id: string, fileName: string, isPublic: boolean): Promise<void> => {
    await pool.query(
      `INSERT INTO asset (id, production_id, uploader_user_id, file_name, is_public)
       VALUES ($1, $2, $3::uuid, $4, $5) ON CONFLICT DO NOTHING`,
      [id, prodId, userId, fileName, isPublic],
    );
    await pool.query(
      `INSERT INTO resource_person_manage (production_id, user_id, resource_type, resource_id, established_by)
       VALUES ($1, $2::uuid, 'asset', $3, $2::uuid) ON CONFLICT DO NOTHING`,
      [prodId, userId, id],
    );
  };
  let mountSeq = 0;
  const mkMount = async (
    assetId: string, mountType: string, mountId: string, folderPath: string | null,
  ): Promise<string> => {
    const id = `amndtr${++mountSeq}`;
    await pool.query(
      `INSERT INTO asset_mount (id, asset_id, production_id, mount_type, mount_id, folder_path, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid) ON CONFLICT DO NOTHING`,
      [id, assetId, prodId, mountType, mountId, folderPath, userId],
    );
    return id;
  };

  const [a1, a2, a3, a4, a5, a6, a7, a8] =
    ["astndtr1", "astndtr2", "astndtr3", "astndtr4", "astndtr5", "astndtr6", "astndtr7", "astndtr8"];
  await mkAsset(a1, "共享带目录.png", false);
  await mkMount(a1, "production", prodId, "设计/平面图");
  await mkAsset(a2, "共享无目录.pdf", false);
  await mkMount(a2, "production", prodId, null);
  await mkAsset(a3, "私有定向分享.wav", false);
  await pool.query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
     VALUES ($1, $2::uuid, 'asset', $3, 'meta', 'view', 'direct', $2::uuid)
     ON CONFLICT DO NOTHING`,
    [prodId, u2Id, a3],
  );

  // block_snapshot 映射行：script 快照行 + version + script_version(block_id 稳定)
  const versionId = "verndtrmig1";
  await pool.query(
    `INSERT INTO version (id, production_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [versionId, prodId],
  );
  await pool.query(
    `UPDATE production SET active_version_id = COALESCE(active_version_id, $2) WHERE id = $1`,
    [prodId, versionId],
  ).catch(() => {});
  const blockSnapshotId = "snndtrmig1";
  const blockStableId = "blkndtrst1";
  await pool.query(
    `INSERT INTO script (id, production_id, sort_key, type, content, block_id)
     VALUES ($1, $2, 'a0', 'dialogue', '迁移块', $3) ON CONFLICT DO NOTHING`,
    [blockSnapshotId, prodId, blockStableId],
  );
  await pool.query(
    `INSERT INTO script_version (snapshot_id, version_id, block_id, sort_key)
     VALUES ($1, $2, $3, 'a0') ON CONFLICT DO NOTHING`,
    [blockSnapshotId, versionId, blockStableId],
  );
  await mkAsset(a4, "挂快照.png", false);
  await mkMount(a4, "block_snapshot", blockSnapshotId, null);

  // cue_revision：cue 修订行（稳定身份在 cue.cue_id 列）
  const cueListId = "clndtrmig1";
  await pool.query(
    `INSERT INTO cue_list (id, production_id, name, created_by) VALUES ($1, $2, 'node迁移cue表', $3::uuid)
     ON CONFLICT DO NOTHING`,
    [cueListId, prodId, userId],
  );
  const cueRevisionRowId = "cuendtrrev1";
  const cueStableId = "cuendtrst1";
  await pool.query(
    `INSERT INTO cue (id, cue_list_id, number, start_kind, end_kind, cue_id)
     VALUES ($1, $2, '1', 'gap', 'gap', $3) ON CONFLICT DO NOTHING`,
    [cueRevisionRowId, cueListId, cueStableId],
  );
  await mkAsset(a5, "挂cue修订.mp3", false);
  await mkMount(a5, "cue_revision", cueRevisionRowId, null);

  await mkAsset(a6, "正文嵌图.png", false);
  await mkMount(a6, "wiki", wikiA, null);

  await mkAsset(a7, "化石挂载.zip", false);
  await mkMount(a7, "version", versionId, null);
  await mkMount(a7, "scene_snapshot", "scnndtrx1", null);

  const a8Folder2 = "音效";
  await mkAsset(a8, "双目录.wav", true); // is_public=true：验证迁入 node.is_public
  await mkMount(a8, "production", prodId, "设计/平面图");
  await mkMount(a8, "production", prodId, a8Folder2);

  await pool.query(
    `INSERT INTO asset_share_token (token, asset_id, production_id, created_by)
     VALUES ('tokndtrmig1', $1, $2, $3::uuid) ON CONFLICT DO NOTHING`,
    [a1, prodId, userId],
  );

  const { rows: [m1] } = await pool.query<{ created_by: string }>(
    `SELECT created_by::text AS created_by FROM asset_mount WHERE asset_id = $1 AND mount_type = 'production' LIMIT 1`,
    [a1],
  );

  return {
    prodId, userId, u2Id, deptId,
    wikiA, wikiB, wikiC, sortA, sortB, sortC,
    aliasId, aliasSort, aliasTitle,
    reportsRootWiki, eventId, eventDocWiki, reportId, reportWiki, noteId, noteWiki,
    dramaturgyRootWiki,
    a1, a2, a3, a4, a5, a6, a7, a8,
    a1MountCreatedBy: m1.created_by,
    blockSnapshotId, blockStableId, cueRevisionRowId, cueStableId,
    a8Folder2,
  };
}
