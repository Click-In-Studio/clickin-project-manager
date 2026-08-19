import { config } from "dotenv";
config({ path: ".env.local" });

import { readFile, writeFile, unlink } from "fs/promises";
import path from "path";
import { getPool } from "@/lib/pg";
import { faker } from "@faker-js/faker";
import {
  isPreMigrationSchema,
  createPreMigrationData,
  SNAPSHOT_PATH,
  type PreMigrationSnapshot,
} from "./migration-snapshot";
import {
  isCueListRolePreMigrationSchema,
  createCueListRolePreMigrationData,
  CUE_LIST_ROLE_SNAPSHOT_PATH,
  type CueListRoleSnapshot,
} from "./cue-list-role-snapshot";
import {
  isMemberRolesPreMigrationSchema,
  createMemberRolesPreMigrationData,
  MEMBER_ROLES_SNAPSHOT_PATH,
  type MemberRolesSnapshot,
} from "./member-roles-snapshot";
import {
  isDeptPocCleanupPreMigrationSchema,
  createDeptPocCleanupPreMigrationData,
  DEPT_POC_CLEANUP_SNAPSHOT_PATH,
  type DeptPocCleanupSnapshot,
} from "./dept-poc-cleanup-snapshot";
import {
  isEventDeptPreMigrationSchema,
  createEventDeptPreMigrationData,
  EVENT_DEPT_SNAPSHOT_PATH,
  type EventDeptSnapshot,
} from "./event-department-snapshot";
import {
  isRoleCueTypePreMigrationSchema,
  createRoleCueTypePreMigrationData,
  ROLE_CUE_TYPE_SNAPSHOT_PATH,
  type RoleCueTypeSnapshot,
} from "./role-cue-type-snapshot";
import {
  isCueListGrantPreMigrationSchema,
  createCueListGrantPreMigrationData,
  CUE_LIST_GRANT_SNAPSHOT_PATH,
  type CueListGrantSnapshot,
} from "./cue-list-grant-snapshot";
import {
  isScriptRestPreMigrationSchema,
  createScriptRestPreMigrationData,
  SCRIPT_REST_SNAPSHOT_PATH,
} from "./script-rest-snapshot";
import {
  isSceneCharTagRestPreMigrationSchema,
  createSceneCharTagRestPreMigrationData,
  SCENE_CHAR_TAG_REST_SNAPSHOT_PATH,
} from "./scene-char-tag-rest-snapshot";
import {
  isAssetRestPreMigrationSchema,
  createAssetRestPreMigrationData,
  ASSET_REST_SNAPSHOT_PATH,
} from "./asset-rest-snapshot";
import {
  isReportNoteRestPreMigrationSchema,
  createReportNoteRestPreMigrationData,
  REPORT_NOTE_REST_SNAPSHOT_PATH,
  type ReportNoteRestSnapshot,
} from "./report-note-rest-snapshot";
import {
  isWikiSplitPreMigrationSchema,
  createWikiSplitPreMigrationData,
  WIKI_SPLIT_SNAPSHOT_PATH,
  type WikiSplitSnapshot,
} from "./wiki-split-snapshot";
import {
  isEventTaskRestPreMigrationSchema,
  createEventTaskRestPreMigrationData,
  EVENT_TASK_REST_SNAPSHOT_PATH,
  type EventTaskRestSnapshot,
} from "./event-task-rest-snapshot";
import {
  isCueDomainRestPreMigrationSchema,
  createCueDomainRestPreMigrationData,
  CUE_DOMAIN_REST_SNAPSHOT_PATH,
  type CueDomainRestSnapshot,
} from "./cue-domain-rest-snapshot";
import {
  isSceneFieldGatesPreMigrationSchema,
  createSceneFieldGatesPreMigrationData,
  SCENE_FIELD_GATES_SNAPSHOT_PATH,
} from "./scene-field-gates-snapshot";

import {
  isLocalScriptDataPreMigrationSchema,
  createLocalScriptDataPreMigrationData,
  LOCAL_SCRIPT_DATA_SNAPSHOT_PATH,
  type LocalScriptDataSnapshot,
} from "./local-script-data-snapshot";
import {
  isMergeEventDeptPreMigrationSchema,
  createMergeEventDeptPreMigrationData,
  MERGE_EVENT_DEPT_SNAPSHOT_PATH,
} from "./merge-event-department-snapshot";
import {
  isTaskStandalonePreMigrationSchema,
  createTaskStandalonePreMigrationData,
  TASK_STANDALONE_SNAPSHOT_PATH,
  type TaskStandaloneSnapshot,
} from "./task-standalone-snapshot";
import {
  isWikiDefaultTreePreMigrationSchema,
  createWikiDefaultTreePreMigrationData,
  WIKI_DEFAULT_TREE_SNAPSHOT_PATH,
  type WikiDefaultTreeSnapshot,
} from "./wiki-default-tree-snapshot";
import {
  isGrantTemplateRetirePreMigrationSchema,
  createGrantTemplateRetirePreMigrationData,
  GRANT_TEMPLATE_RETIRE_SNAPSHOT_PATH,
} from "./grant-template-retire-snapshot";
import {
  isWikiCreateBaselinePreMigrationSchema,
  createWikiCreateBaselinePreMigrationData,
  WIKI_CREATE_BASELINE_SNAPSHOT_PATH,
  type WikiCreateBaselineSnapshot,
} from "./wiki-create-baseline-snapshot";

// Fixed UUID for the test system user — must match TEST_USER in helpers.ts
const TEST_USER = "00000000-0000-0000-0000-000000000001";
const TEST_OWNER = "00000000-0000-0000-0000-0000000000ff";

export async function setup() {
  // Generate deterministic TEST_SEED for faker (workers inherit process.env).
  if (!process.env.TEST_SEED) {
    process.env.TEST_SEED = String(Math.floor(Math.random() * 0xffff_ffff));
  }
  console.log(
    `\nTest seed: ${process.env.TEST_SEED}  (reproduce: TEST_SEED=${process.env.TEST_SEED} npm test)\n`,
  );

  const pool = getPool();

  // grant_template 已退役（#163）。下面三支历史迁移的 PRE 判据都查这张表——表没了
  // 它们的重放也就无从谈起（源表是它自己），统一用这个开关跳过。
  const hasGrantTemplate = (await pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'grant_template'`,
  )).rows.length > 0;

  if (await isPreMigrationSchema(pool)) {
    // Migration path: DB is on the old schema (pre-internal-user-id).
    const snapshot = await createPreMigrationData(pool, faker);
    await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-internal-user-id.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  // Insert the test system user (always runs on post-internal-user-id schema).
  // app_user must exist before feishu_user (FK: feishu_user.user_id → app_user.id).
  await pool.query(
    `INSERT INTO app_user (id, created_at) VALUES ($1, NOW()) ON CONFLICT DO NOTHING`,
    [TEST_USER],
  );
  // 建演出用的专用 owner（与 TEST_USER 分开，见 helpers.ts TEST_OWNER 注释）
  await pool.query(
    `INSERT INTO app_user (id, created_at) VALUES ($1, NOW()) ON CONFLICT DO NOTHING`,
    [TEST_OWNER],
  );
  await pool.query(
    `INSERT INTO feishu_user (open_id, user_id, name, is_super_admin, created_at, updated_at)
     VALUES ('test-sys-feishu', $1, '测试系统用户', FALSE, NOW(), NOW())
     ON CONFLICT DO NOTHING`,
    [TEST_USER],
  );

  if (await isCueListRolePreMigrationSchema(pool)) {
    // Migration path: DB has default_edit_roles column (pre-cue-list-role).
    // TEST_USER already inserted above; use it as creator for factory rows.
    const cueListRoleSnapshot = await createCueListRolePreMigrationData(pool, TEST_USER);
    await writeFile(CUE_LIST_ROLE_SNAPSHOT_PATH, JSON.stringify(cueListRoleSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-cue-list-role.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  if (await isMemberRolesPreMigrationSchema(pool)) {
    // Migration path: production_member_role table doesn't exist yet.
    // TEST_USER already inserted above; use it as the factory member.
    const memberRolesSnapshot = await createMemberRolesPreMigrationData(pool, TEST_USER);
    await writeFile(MEMBER_ROLES_SNAPSHOT_PATH, JSON.stringify(memberRolesSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-member-roles.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  if (await isDeptPocCleanupPreMigrationSchema(pool)) {
    // Migration path: poc_block_write_from_children column still exists.
    // TEST_USER already inserted above; use it as the factory dept member.
    const deptPocSnapshot = await createDeptPocCleanupPreMigrationData(pool, TEST_USER);
    await writeFile(DEPT_POC_CLEANUP_SNAPSHOT_PATH, JSON.stringify(deptPocSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-dept-member-poc-cleanup.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  if (await isEventDeptPreMigrationSchema(pool)) {
    // Migration path: event_department data not yet in production_dept.
    // TEST_USER already inserted above.
    const eventDeptSnapshot = await createEventDeptPreMigrationData(pool, TEST_USER);
    await writeFile(EVENT_DEPT_SNAPSHOT_PATH, JSON.stringify(eventDeptSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-event-department.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  if (await isRoleCueTypePreMigrationSchema(pool)) {
    // Migration path: production_role_cue_type table still exists.
    const roleCueTypeSnapshot = await createRoleCueTypePreMigrationData(pool, TEST_USER);
    await writeFile(ROLE_CUE_TYPE_SNAPSHOT_PATH, JSON.stringify(roleCueTypeSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-role-cue-type-to-dept.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  if (await isCueListGrantPreMigrationSchema(pool)) {
    // Migration path: cue_list_permission table still exists.
    const cueListGrantSnapshot = await createCueListGrantPreMigrationData(pool, TEST_USER);
    await writeFile(CUE_LIST_GRANT_SNAPSHOT_PATH, JSON.stringify(cueListGrantSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-cue-list-to-resource-grant.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  if (await isCueDomainRestPreMigrationSchema(pool)) {
    // 批A migration path: legacy cue_list manage level still in vocabulary.
    const cueDomainRestSnapshot = await createCueDomainRestPreMigrationData(pool, TEST_USER);
    await writeFile(CUE_DOMAIN_REST_SNAPSHOT_PATH, JSON.stringify(cueDomainRestSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-cue-domain-rest.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  if (await isEventTaskRestPreMigrationSchema(pool)) {
    // 批B migration path: legacy event manage level still in vocabulary.
    const etrSnapshot = await createEventTaskRestPreMigrationData(pool, TEST_USER);
    await writeFile(EVENT_TASK_REST_SNAPSHOT_PATH, JSON.stringify(etrSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-event-task-rest.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  if (await isWikiSplitPreMigrationSchema(pool)) {
    // 批C PR-C1 migration path: event_report still carries content columns.
    const wikiSplitSnapshot = await createWikiSplitPreMigrationData(pool, TEST_USER);
    await writeFile(WIKI_SPLIT_SNAPSHOT_PATH, JSON.stringify(wikiSplitSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-report-note-wiki-split.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  if (await isReportNoteRestPreMigrationSchema(pool)) {
    // 批C PR-C2 migration path: legacy report manage level still in vocabulary.
    const rnrSnapshot = await createReportNoteRestPreMigrationData(pool, TEST_USER);
    await writeFile(REPORT_NOTE_REST_SNAPSHOT_PATH, JSON.stringify(rnrSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-report-note-rest.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  if (await isAssetRestPreMigrationSchema(pool)) {
    // Migration path（批D）: asset manage 词汇行仍在。
    const assetRestSnapshot = await createAssetRestPreMigrationData(pool, TEST_USER);
    await writeFile(ASSET_REST_SNAPSHOT_PATH, JSON.stringify(assetRestSnapshot));
    for (const file of ["db/add-asset-visibility.sql", "db/migrate-asset-rest.sql"]) {
      const migrationSql = await readFile(path.resolve(process.cwd(), file), "utf8");
      await pool.query(migrationSql);
    }
  }

  if (await isSceneCharTagRestPreMigrationSchema(pool)) {
    // Migration path（批E PR-E1）: scene manage 词汇行仍在。
    const sctSnapshot = await createSceneCharTagRestPreMigrationData(pool, TEST_USER);
    await writeFile(SCENE_CHAR_TAG_REST_SNAPSHOT_PATH, JSON.stringify(sctSnapshot));
    for (const file of ["db/add-scene-char-tag-verbs.sql", "db/migrate-scene-char-tag-rest.sql"]) {
      const migrationSql = await readFile(path.resolve(process.cwd(), file), "utf8");
      await pool.query(migrationSql);
    }
  }

  if (await isScriptRestPreMigrationSchema(pool)) {
    // Migration path（批E PR-E2）: script 词汇行尚不存在。
    const srSnapshot = await createScriptRestPreMigrationData(pool, TEST_USER);
    await writeFile(SCRIPT_REST_SNAPSHOT_PATH, JSON.stringify(srSnapshot));
    for (const file of ["db/add-script-dramaturgy-verbs.sql", "db/migrate-script-rest.sql"]) {
      const migrationSql = await readFile(path.resolve(process.cwd(), file), "utf8");
      await pool.query(migrationSql);
    }
  }

  {
    // 批E PR-E3（个人视图）：零消费键无 invariance，但 CI 迁移路径仍须重放迁移
    // （否则词汇断言对 pre 态失败）。PRE 判据：script_view manage 词汇行仍在。
    const e3Pre = await pool.query(
      `SELECT 1 FROM resource_permission_level
       WHERE resource_type = 'script_view' AND permission_level = 'manage'`,
    );
    if (e3Pre.rows.length > 0) {
      const migrationSql = await readFile(
        path.resolve(process.cwd(), "db/migrate-personal-view-rest.sql"),
        "utf8",
      );
      await pool.query(migrationSql);
    }
  }

  {
    // 批F（治理域）：CI 迁移路径重放。PRE 判据：production 词汇行尚不存在。
    const fPre = await pool.query(
      `SELECT 1 FROM resource_permission_level
       WHERE resource_type = 'production' AND permission_level = 'view'`,
    );
    if (fPre.rows.length === 0) {
      for (const file of ["db/add-governance-verbs.sql", "db/migrate-governance-rest.sql"]) {
        const migrationSql = await readFile(path.resolve(process.cwd(), file), "utf8");
        await pool.query(migrationSql);
      }
    }
  }

  {
    // 批G G-1（制作人通配区间）：CI 迁移路径重放。PRE 判据：模板尚无通配主行。
    const g1Pre = hasGrantTemplate ? await pool.query(
      `SELECT 1 FROM grant_template WHERE role_name = '制作人' AND permission_key = 'node:*/*@*'`,
    ) : { rows: [1] };
    if (g1Pre.rows.length === 0) {
      const migrationSql = await readFile(
        path.resolve(process.cwd(), "db/migrate-producer-wildcard.sql"),
        "utf8",
      );
      await pool.query(migrationSql);
    }
  }

  {
    // 批G G-2（终局清理）：CI 迁移路径重放。PRE 判据：atomic 表仍存在。
    const g2Pre = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'atomic_permission_grant'`,
    );
    if (g2Pre.rows.length > 0) {
      const migrationSql = await readFile(
        path.resolve(process.cwd(), "db/migrate-terminal-cleanup.sql"),
        "utf8",
      );
      await pool.query(migrationSql);
    }
  }

  {
    // 两个指派面（2026-08-13）：CI 迁移路径重放。PRE 判据：舞监模板尚无 event 通配 view。
    const acPre = hasGrantTemplate ? await pool.query(
      `SELECT 1 FROM grant_template WHERE role_name = '舞台监督' AND permission_key = 'node:event/*@view'`,
    ) : { rows: [1] };
    if (acPre.rows.length === 0) {
      const migrationSql = await readFile(
        path.resolve(process.cwd(), "db/migrate-event-assignee-callsheet.sql"),
        "utf8",
      );
      await pool.query(migrationSql);
    }
  }

  {
    // Cue 模版声明表（§3.5）：CI 迁移路径重放。PRE 判据：表不存在。
    const ctPre = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'dept_cue_list_template'`,
    );
    if (ctPre.rows.length === 0) {
      const migrationSql = await readFile(
        path.resolve(process.cwd(), "db/migrate-dept-cue-template.sql"),
        "utf8",
      );
      await pool.query(migrationSql);
    }
  }

  {
    // 角色模板对齐 + 退役键清理（2026-08-17）：PRE 判据=编剧模板尚无 blocks@edit。
    // 必须在字段门迁移之前跑——它清 grant_template 的退役键残留，字段门那支
    // 随后往同一张表补字段级键。
    const pre = hasGrantTemplate ? await pool.query(
      `SELECT 1 FROM grant_template
       WHERE role_name = '编剧' AND permission_key = 'node:script/*/blocks@edit'`,
    ) : { rows: [1] };
    if (pre.rows.length === 0) {
      const migrationSql = await readFile(
        path.resolve(process.cwd(), "db/migrate-role-template-seed.sql"),
        "utf8",
      );
      await pool.query(migrationSql);
    }
  }

  if (await isSceneFieldGatesPreMigrationSchema(pool)) {
    // scene 字段门对齐（2026-08-17）：PRE 判据=编剧模板尚无 meta/name@edit。
    const sfgSnapshot = await createSceneFieldGatesPreMigrationData(pool, TEST_USER);
    await writeFile(SCENE_FIELD_GATES_SNAPSHOT_PATH, JSON.stringify(sfgSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-scene-field-gates.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  if (await isLocalScriptDataPreMigrationSchema(pool)) {
    const snapshot = await createLocalScriptDataPreMigrationData(pool, TEST_USER);
    await writeFile(LOCAL_SCRIPT_DATA_SNAPSHOT_PATH, JSON.stringify(snapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-script-comment-rehearsal-defaults.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  const legacyCueNumberConstraint = await pool.query(
    `SELECT 1 FROM pg_constraint
     WHERE conrelid = 'cue'::regclass
       AND conname = 'cue_cue_list_id_number_key'`,
  );
  if (legacyCueNumberConstraint.rows.length > 0) {
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-cue-revision-number-uniqueness.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  // 并表迁移（event_department → production_dept）：必须最后跑——
  // 前序旧迁移的工厂/重放仍然向 event_department 写行。
  if (await isMergeEventDeptPreMigrationSchema(pool)) {
    const mergeSnapshot = await createMergeEventDeptPreMigrationData(pool, TEST_USER);
    await writeFile(MERGE_EVENT_DEPT_SNAPSHOT_PATH, JSON.stringify(mergeSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-merge-event-department.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  // Task 独立化（event_tech_req → task）：必须在并表迁移之后——
  // 并表迁移与前序工厂仍按旧表名 event_tech_req 读写。
  if (await isTaskStandalonePreMigrationSchema(pool)) {
    const taskSnapshot = await createTaskStandalonePreMigrationData(pool, TEST_USER);
    await writeFile(TASK_STANDALONE_SNAPSHOT_PATH, JSON.stringify(taskSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-task-standalone.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  // wiki 默认文档树存量归位：依赖并表后 production_dept（note 赋题 join）与
  // add-wiki-library 的树列，放全部老迁移之后
  if (await isWikiDefaultTreePreMigrationSchema(pool)) {
    const wikiTreeSnapshot = await createWikiDefaultTreePreMigrationData(pool, TEST_USER);
    await writeFile(WIKI_DEFAULT_TREE_SNAPSHOT_PATH, JSON.stringify(wikiTreeSnapshot));
    for (const file of ["db/add-wiki-default-tree.sql", "db/migrate-wiki-default-tree.sql"]) {
      const sql = await readFile(path.resolve(process.cwd(), file), "utf8");
      await pool.query(sql);
    }
  }

  // wiki 创建资格基线回填（W3 部署缺口：grant_template 零读取，存量 role 无键）
  if (await isWikiCreateBaselinePreMigrationSchema(pool)) {
    const baselineSnapshot = await createWikiCreateBaselinePreMigrationData(pool, TEST_USER);
    await writeFile(WIKI_CREATE_BASELINE_SNAPSHOT_PATH, JSON.stringify(baselineSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-wiki-create-baseline.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  // grant_template 退役（#163）：先把表内容整份快照下来，迁移测试拿它验证
  // 项目模版常量一键不差地重现了这份模板，然后才 DROP。
  if (await isGrantTemplateRetirePreMigrationSchema(pool)) {
    const retireSnapshot = await createGrantTemplateRetirePreMigrationData(pool);
    await writeFile(GRANT_TEMPLATE_RETIRE_SNAPSHOT_PATH, JSON.stringify(retireSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-retire-grant-template.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }
}

export async function teardown() {
  const pool = getPool();

  // grant_template 退役快照：纯表内容 dump，没有工厂行要清，只删文件。
  await unlink(GRANT_TEMPLATE_RETIRE_SNAPSHOT_PATH).catch(() => {});

  // Clean up wiki-create-baseline migration factory data (migration path only).
  {
    let baselineSnapshot: WikiCreateBaselineSnapshot | null = null;
    try {
      baselineSnapshot = JSON.parse(
        await readFile(WIKI_CREATE_BASELINE_SNAPSHOT_PATH, "utf8"),
      ) as WikiCreateBaselineSnapshot;
    } catch {
      // Normal path: no snapshot file.
    }
    if (baselineSnapshot) {
      await pool.query("DELETE FROM production WHERE id = $1", [baselineSnapshot.prodId]).catch(() => {});
      await unlink(WIKI_CREATE_BASELINE_SNAPSHOT_PATH).catch(() => {});
    }
  }

  // Clean up wiki-default-tree migration factory data (migration path only).
  {
    let wikiTreeSnapshot: WikiDefaultTreeSnapshot | null = null;
    try {
      wikiTreeSnapshot = JSON.parse(
        await readFile(WIKI_DEFAULT_TREE_SNAPSHOT_PATH, "utf8"),
      ) as WikiDefaultTreeSnapshot;
    } catch {
      // Normal path: no snapshot file.
    }
    if (wikiTreeSnapshot) {
      // production 删除级联 wiki/config/event 全家族
      await pool.query("DELETE FROM production WHERE id = $1", [wikiTreeSnapshot.prodId]).catch(() => {});
      await unlink(WIKI_DEFAULT_TREE_SNAPSHOT_PATH).catch(() => {});
    }
  }

  // Clean up task-standalone migration factory data (migration path only).
  {
    let taskSnapshot: TaskStandaloneSnapshot | null = null;
    try {
      taskSnapshot = JSON.parse(
        await readFile(TASK_STANDALONE_SNAPSHOT_PATH, "utf8"),
      ) as TaskStandaloneSnapshot;
    } catch {
      // Normal path: no snapshot file.
    }
    if (taskSnapshot) {
      // production 删除经 task.production_id CASCADE 清 task/asset/event 全家族
      await pool.query("DELETE FROM production WHERE id = $1", [taskSnapshot.prodId]).catch(() => {});
      await unlink(TASK_STANDALONE_SNAPSHOT_PATH).catch(() => {});
    }
  }

  // Clean up merge-event-department migration factory data (migration path only).
  {
    let mergeSnapshot: { prodId: string } | null = null;
    try {
      mergeSnapshot = JSON.parse(
        await readFile(MERGE_EVENT_DEPT_SNAPSHOT_PATH, "utf8"),
      ) as { prodId: string };
    } catch {
      // Normal path: no snapshot file.
    }
    if (mergeSnapshot) {
      await pool.query("DELETE FROM production WHERE id = $1", [mergeSnapshot.prodId]).catch(() => {});
      await unlink(MERGE_EVENT_DEPT_SNAPSHOT_PATH).catch(() => {});
    }
  }

  let localScriptDataSnapshot: LocalScriptDataSnapshot | null = null;
  try {
    localScriptDataSnapshot = JSON.parse(
      await readFile(LOCAL_SCRIPT_DATA_SNAPSHOT_PATH, "utf8"),
    ) as LocalScriptDataSnapshot;
  } catch {
    // Normal path: no snapshot file.
  }
  if (localScriptDataSnapshot) {
    await pool.query(
      "DELETE FROM production WHERE id = ANY($1::text[])",
      [Object.values(localScriptDataSnapshot.productionIds)],
    ).catch(() => {});
    await unlink(LOCAL_SCRIPT_DATA_SNAPSHOT_PATH).catch(() => {});
  }

  // Tables with no ON DELETE CASCADE from app_user need explicit cleanup first.
  await pool.query("DELETE FROM cue_list WHERE created_by = $1", [TEST_USER]);
  await pool.query("DELETE FROM production_event WHERE created_by = $1", [TEST_USER]);
  await pool.query("DELETE FROM wiki WHERE created_by = $1", [TEST_USER]);

  // Clean up cue-list-grant migration factory data (migration path only; no-op otherwise).
  let cueListGrantSnapshot: CueListGrantSnapshot | null = null;
  try {
    cueListGrantSnapshot = JSON.parse(
      await readFile(CUE_LIST_GRANT_SNAPSHOT_PATH, "utf8"),
    ) as CueListGrantSnapshot;
  } catch {
    // Normal path: no snapshot file.
  }
  if (cueListGrantSnapshot) {
    await pool.query(
      "DELETE FROM production WHERE id = $1",
      [cueListGrantSnapshot.production.id],
    ).catch(() => {});
    // Clean up extra test users created for this migration
    await pool.query(
      "DELETE FROM app_user WHERE id IN ($1, $2)",
      [cueListGrantSnapshot.personalGrantUserId, cueListGrantSnapshot.roleGrantUserId],
    ).catch(() => {});
    await unlink(CUE_LIST_GRANT_SNAPSHOT_PATH).catch(() => {});
  }

  // Clean up 批C report-note-rest migration factory data (migration path only; no-op otherwise).
  let rnrSnapshot: ReportNoteRestSnapshot | null = null;
  try {
    rnrSnapshot = JSON.parse(
      await readFile(REPORT_NOTE_REST_SNAPSHOT_PATH, "utf8"),
    ) as ReportNoteRestSnapshot;
  } catch {
    // Normal path: no snapshot file.
  }
  if (rnrSnapshot) {
    await pool.query("DELETE FROM production_event WHERE id = $1", [rnrSnapshot.eventId]).catch(() => {});
    await pool.query("DELETE FROM production WHERE id = $1", [rnrSnapshot.productionId]).catch(() => {});
    await pool.query(
      "DELETE FROM app_user WHERE id IN ($1, $2)",
      [rnrSnapshot.manageUserId, rnrSnapshot.atomicUserId],
    ).catch(() => {});
    await unlink(REPORT_NOTE_REST_SNAPSHOT_PATH).catch(() => {});
  }

  // Clean up 批C wiki-split migration factory data (migration path only; no-op otherwise).
  let wikiSplitSnapshot: WikiSplitSnapshot | null = null;
  try {
    wikiSplitSnapshot = JSON.parse(
      await readFile(WIKI_SPLIT_SNAPSHOT_PATH, "utf8"),
    ) as WikiSplitSnapshot;
  } catch {
    // Normal path: no snapshot file.
  }
  if (wikiSplitSnapshot) {
    await pool.query("DELETE FROM production_event WHERE id = $1", [wikiSplitSnapshot.eventId]).catch(() => {});
    await pool.query("DELETE FROM production WHERE id = $1", [wikiSplitSnapshot.productionId]).catch(() => {});
    await unlink(WIKI_SPLIT_SNAPSHOT_PATH).catch(() => {});
  }

  // Clean up 批B event-task-rest migration factory data (migration path only; no-op otherwise).
  let etrSnapshot: EventTaskRestSnapshot | null = null;
  try {
    etrSnapshot = JSON.parse(
      await readFile(EVENT_TASK_REST_SNAPSHOT_PATH, "utf8"),
    ) as EventTaskRestSnapshot;
  } catch {
    // Normal path: no snapshot file.
  }
  if (etrSnapshot) {
    await pool.query("DELETE FROM production_event WHERE id = $1", [etrSnapshot.eventId]).catch(() => {});
    await pool.query("DELETE FROM production WHERE id = $1", [etrSnapshot.productionId]).catch(() => {});
    await pool.query(
      "DELETE FROM app_user WHERE id IN ($1, $2, $3)",
      [etrSnapshot.manageUserId, etrSnapshot.assignUserId, etrSnapshot.atomicUserId],
    ).catch(() => {});
    await unlink(EVENT_TASK_REST_SNAPSHOT_PATH).catch(() => {});
  }

  // Clean up 批A cue-domain-rest migration factory data (migration path only; no-op otherwise).
  let cueDomainRestSnapshot: CueDomainRestSnapshot | null = null;
  try {
    cueDomainRestSnapshot = JSON.parse(
      await readFile(CUE_DOMAIN_REST_SNAPSHOT_PATH, "utf8"),
    ) as CueDomainRestSnapshot;
  } catch {
    // Normal path: no snapshot file.
  }
  if (cueDomainRestSnapshot) {
    await pool.query(
      "DELETE FROM cue_list WHERE id = $1",
      [cueDomainRestSnapshot.cueListId],
    ).catch(() => {});
    await pool.query(
      "DELETE FROM production WHERE id = $1",
      [cueDomainRestSnapshot.productionId],
    ).catch(() => {});
    await pool.query(
      "DELETE FROM app_user WHERE id IN ($1, $2, $3)",
      [cueDomainRestSnapshot.manageUserId, cueDomainRestSnapshot.editUserId, cueDomainRestSnapshot.atomicUserId],
    ).catch(() => {});
    await unlink(CUE_DOMAIN_REST_SNAPSHOT_PATH).catch(() => {});
  }

  // Clean up role-cue-type migration factory data (migration path only; no-op otherwise).
  let roleCueTypeSnapshot: RoleCueTypeSnapshot | null = null;
  try {
    roleCueTypeSnapshot = JSON.parse(
      await readFile(ROLE_CUE_TYPE_SNAPSHOT_PATH, "utf8"),
    ) as RoleCueTypeSnapshot;
  } catch {
    // Normal path: no snapshot file.
  }
  if (roleCueTypeSnapshot) {
    await pool.query(
      "DELETE FROM production WHERE id = $1",
      [roleCueTypeSnapshot.production.id],
    ).catch(() => {});
    await unlink(ROLE_CUE_TYPE_SNAPSHOT_PATH).catch(() => {});
  }

  // Clean up event-department migration factory data (migration path only; no-op otherwise).
  let eventDeptSnapshot: EventDeptSnapshot | null = null;
  try {
    eventDeptSnapshot = JSON.parse(
      await readFile(EVENT_DEPT_SNAPSHOT_PATH, "utf8"),
    ) as EventDeptSnapshot;
  } catch {
    // Normal path: no snapshot file.
  }
  if (eventDeptSnapshot) {
    await pool.query(
      "DELETE FROM production WHERE id = $1",
      [eventDeptSnapshot.production.id],
    ).catch(() => {});
    await unlink(EVENT_DEPT_SNAPSHOT_PATH).catch(() => {});
  }

  // Clean up dept-poc-cleanup migration factory data (migration path only; no-op otherwise).
  let deptPocCleanupSnapshot: DeptPocCleanupSnapshot | null = null;
  try {
    deptPocCleanupSnapshot = JSON.parse(
      await readFile(DEPT_POC_CLEANUP_SNAPSHOT_PATH, "utf8"),
    ) as DeptPocCleanupSnapshot;
  } catch {
    // Normal path: no snapshot file.
  }
  if (deptPocCleanupSnapshot) {
    await pool.query(
      "DELETE FROM production WHERE id = $1",
      [deptPocCleanupSnapshot.production.id],
    ).catch(() => {});
    await unlink(DEPT_POC_CLEANUP_SNAPSHOT_PATH).catch(() => {});
  }

  // Clean up member-roles migration factory data (migration path only; no-op otherwise).
  let memberRolesSnapshot: MemberRolesSnapshot | null = null;
  try {
    memberRolesSnapshot = JSON.parse(
      await readFile(MEMBER_ROLES_SNAPSHOT_PATH, "utf8"),
    ) as MemberRolesSnapshot;
  } catch {
    // Normal path: no snapshot file.
  }
  if (memberRolesSnapshot) {
    await pool.query(
      "DELETE FROM production WHERE id = $1",
      [memberRolesSnapshot.production.id],
    ).catch(() => {});
    await unlink(MEMBER_ROLES_SNAPSHOT_PATH).catch(() => {});
  }

  // Clean up cue-list-role migration factory data (migration path only; no-op otherwise).
  let cueListRoleSnapshot: CueListRoleSnapshot | null = null;
  try {
    cueListRoleSnapshot = JSON.parse(
      await readFile(CUE_LIST_ROLE_SNAPSHOT_PATH, "utf8"),
    ) as CueListRoleSnapshot;
  } catch {
    // Normal path: no snapshot file.
  }
  if (cueListRoleSnapshot) {
    await pool.query(
      "DELETE FROM production WHERE id = $1",
      [cueListRoleSnapshot.production.id],
    ).catch(() => {});
    await unlink(CUE_LIST_ROLE_SNAPSHOT_PATH).catch(() => {});
  }

  // Clean up internal-user-id migration factory data (migration path only; no-ops otherwise).
  let snapshot: PreMigrationSnapshot | null = null;
  try {
    snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")) as PreMigrationSnapshot;
  } catch {
    // Normal path: no snapshot file, nothing to clean up.
  }
  if (snapshot) {
    // DELETE FROM production cascades to production_member, cue_list, production_event, comment.
    await pool.query("DELETE FROM production WHERE id = $1", [snapshot.production.id]).catch(() => {});
    // Delete app_user records created by migration for the factory users; cascades to feishu_user.
    const openIds = snapshot.users.map((u) => u.openId);
    await pool.query(
      "DELETE FROM app_user WHERE id IN (SELECT user_id FROM feishu_user WHERE open_id = ANY($1))",
      [openIds],
    ).catch(() => {});
    await unlink(SNAPSHOT_PATH).catch(() => {});
  }

  // Deleting app_user cascades to feishu_user, production_member, comment, etc.
  await pool.query("DELETE FROM app_user WHERE id = $1", [TEST_USER]);
  await pool.end();
}
