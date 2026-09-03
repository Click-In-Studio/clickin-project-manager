/**
 * Rebuild the local demo production for the currently signed-in developer.
 *
 * Run from the repository root:
 *   npx tsx scripts/seed-local-demo.ts
 *
 * The script only replaces the fixed `demo-misty-harbor` production. It leaves
 * accounts and any non-demo projects untouched.
 */
import path from "node:path";
import dotenv from "dotenv";
import { getPool } from "../lib/pg";
import {
  createAnnouncement,
  createProduction,
  updateAnnouncement,
} from "../lib/db";
import {
  createEventCallTime,
  createEventReport,
  createEventTechReq,
  createProductionEvent,
  createScheduleItem,
} from "../lib/event-db";
import { createWiki } from "../lib/wiki-db";
import { createAsset } from "../lib/asset-db";
import { createUserNotification } from "../lib/inbox-db";
import { createMaterial, listMaterialStatuses } from "../lib/material-db";
import { approveExpense, createBudgetCategory, submitExpense } from "../lib/finance-db";
import { createPhase } from "../lib/phase-db";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

if (process.env.NODE_ENV === "production") {
  throw new Error("seed:local-demo 只能在本地运行——它会重建演示项目并写入虚拟成员。");
}

const pool = getPool();
const PRODUCTION_ID = "demo-misty-harbor";
const CST_OFFSET = 8 * 3_600_000;
const DAY = 86_400_000;

function displayedWeekStart(): Date {
  const now = new Date(Date.now() + CST_OFFSET);
  const dow = now.getUTCDay();
  const afterSundayNoon = dow === 0 && now.getUTCHours() >= 12;
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  const monday = now.getUTCDate() - daysFromMonday + (afterSundayNoon ? 7 : 0);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), monday) - CST_OFFSET);
}

function at(start: Date, dayOffset: number, hour: number, minute = 0) {
  return new Date(start.getTime() + dayOffset * DAY + hour * 3_600_000 + minute * 60_000).toISOString();
}

async function main() {
  const userResult = await pool.query<{ id: string; name: string }>(
    // 只从真实登录身份中选本地开发者。按 app_user.created_at 取“最新用户”会在
    // seed 第一次插入虚拟成员后污染下一次运行，把虚拟资源负责人误当成项目 Owner。
    // 显示名仍走 user_profile；user_platform_identity 只负责证明它是登录身份。
    `SELECT au.id, COALESCE(NULLIF(up.display_name, ''), up.name, '本地用户') AS name
     FROM app_user au
     JOIN user_platform_identity upi ON upi.user_id = au.id AND upi.is_login_method = true
     LEFT JOIN user_profile up ON up.user_id = au.id
     ORDER BY upi.created_at DESC
     LIMIT 1`,
  );
  const user = userResult.rows[0];
  if (!user) throw new Error("No local user found. Sign in once before running the demo seed.");

  await pool.query("DELETE FROM production WHERE id = $1", [PRODUCTION_ID]);
  await createProduction(PRODUCTION_ID, "《雾港来信》音乐剧", user.id, "musical", "音乐剧");
  await pool.query(
    `UPDATE production
     SET description = $2, language = 'zh-CN', sort_order = -100,
         script_config = script_config || $3::jsonb
     WHERE id = $1`,
    [
      PRODUCTION_ID,
      "一部发生在海港城市的原创音乐剧。演示项目包含创作、排练、技术、汇报与资产协作数据。",
      JSON.stringify({ stageDelimOpen: "（", stageDelimClose: "）", pageLayout: "a4", textLayoutMode: "center" }),
    ],
  );
  // 部门与角色不写名字。这个脚本每次跑都是先 DELETE 再 createProduction 重建
  // demo-misty-harbor，部门树和角色名单就是上一行 applyProductionTemplate 刚灌进去的
  // 那批——不存在「剧组改过名」的中间状态，按项目自己的定序取用即可。硬写模版当前的
  // 部门名反而会在模版改动时静默失配。
  const leafDepts = (await pool.query<{ id: string; name: string }>(
    `SELECT d.id, d.name
     FROM production_dept d
     WHERE d.production_id = $1
       AND NOT EXISTS (SELECT 1 FROM production_dept c WHERE c.parent_id = d.id)
     ORDER BY d.display_order, d.name`,
    [PRODUCTION_ID],
  )).rows;
  if (leafDepts.length < 4) throw new Error("建项目的模版没有灌出足够的部门，demo 数据无处安放");

  const projectRoles = (await pool.query<{ name: string }>(
    // 模版是一个事务灌完的，created_at 全同 → 实际按名字定序。只要是确定的就行，
    // demo 需要的是「项目里真实存在的几个角色」，不是某几个特定角色。
    "SELECT name FROM production_role WHERE production_id = $1 AND NOT is_deprecated ORDER BY created_at, name",
    [PRODUCTION_ID],
  )).rows.map(row => row.name);
  if (!projectRoles.length) throw new Error("建项目的模版没有灌出角色名单");

  /** demo 的任务 / 成员按下标引用部门，取项目实际的叶子部门轮转。 */
  const deptRows = Array.from({ length: 7 }, (_, i) => leafDepts[i % leafDepts.length]);

  for (const dept of deptRows.slice(0, 2)) {
    await pool.query(
      `INSERT INTO production_dept_member (production_id, user_id, dept_id, is_poc)
       VALUES ($1, $2, $3, true)
       ON CONFLICT DO NOTHING`,
      [PRODUCTION_ID, user.id, dept.id],
    );
  }

  // 角色同理按项目名单取，不写死「灯光设计」这类名字
  const demoMembers = [
    { id: "30000000-0000-4000-8000-000000000001", name: "陈雨", deptIndex: 2 },
    { id: "30000000-0000-4000-8000-000000000002", name: "王澜", deptIndex: 3 },
    { id: "30000000-0000-4000-8000-000000000003", name: "苏禾", deptIndex: 4 },
    { id: "30000000-0000-4000-8000-000000000004", name: "林默", deptIndex: 6 },
    // 注意：轮转会给苏禾挂上「制作人」，findProducers 按该角色串字面匹配，这个
    // 无登录身份的虚拟成员会进真实 producer 审批级。这是 demo 的**有意妥协**：
    // owner 提交的支出（下方 demoExpenses）把 owner 从阶梯里剔除，必须有一位
    // 非 owner 制作人接住，否则财务 seed 直接 no_approver。副作用（转交到
    // producer 级的申请会落在无人能登录的苏禾手上）由 owner 介入权兜底。
    // 因此 demoApprovers 里的唐澄用「制作统筹」——一个幻影制作人是结构必需，
    // 两个就纯属放大滞留面了（#405 review）。
  ].map((member, index) => ({ ...member, roles: [projectRoles[index % projectRoles.length]] }));
  // 审批演示不能只有「申请人 + 当前登录 owner」两个人，否则界面看起来像审批流
  // 根本没做。下面四位只服务于 demo 的历史节点：分别代表直属上级、PM、制作人、
  // 资源负责人。真实产品仍由组织关系和资源治理配置动态匹配。
  // 唐澄不能挂「制作人」：findProducers 按字面匹配该角色串，会把这个无登录
  // 身份的幻影账号注入真实 producer 审批级——转交后申请永久滞留在无人能
  // 处理的账号上（#405 review）。demo 里的「制作」人设用非结构性角色名表达。
  const demoApprovers = [
    { id: "31000000-0000-4000-8000-000000000001", name: "周衡", roles: ["灯光主管"] },
    { id: "31000000-0000-4000-8000-000000000002", name: "姜予安", roles: ["项目经理"] },
    { id: "31000000-0000-4000-8000-000000000003", name: "唐澄", roles: ["制作统筹"] },
    { id: "31000000-0000-4000-8000-000000000004", name: "周岑", roles: ["资源负责人"] },
  ];

  // owner 的 role 只是显示（权限走 isOwner 旁路），取项目名单的前几个即可。
  // upsert 而不是 INSERT/UPDATE 二选一：createProduction 现在自己会落 owner 的
  // production_member 行（#282），裸 INSERT 会主键冲突，裸 UPDATE 在旧版上又是空转。
  const ownerRoles = projectRoles.slice(0, 4);
  await pool.query(
    `INSERT INTO production_member (production_id, user_id, roles, status)
     VALUES ($1, $2, $3::text[], 'active')
     ON CONFLICT (production_id, user_id) DO UPDATE
     SET roles = EXCLUDED.roles, status = EXCLUDED.status`,
    [PRODUCTION_ID, user.id, ownerRoles],
  );
  await pool.query(
    `INSERT INTO production_member_role (production_id, user_id, role_id)
     SELECT $1, $2, id FROM production_role
     WHERE production_id = $1 AND name = ANY($3::text[])
     ON CONFLICT DO NOTHING`,
    [PRODUCTION_ID, user.id, ownerRoles],
  );

  for (const member of demoMembers) {
    await pool.query("INSERT INTO app_user (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [member.id]);
    await pool.query(
      `INSERT INTO user_profile (user_id, name, display_name, bio)
       VALUES ($1,$2,$2,'《雾港来信》虚拟测试成员')
       ON CONFLICT (user_id) DO UPDATE SET name=EXCLUDED.name, display_name=EXCLUDED.display_name, bio=EXCLUDED.bio`,
      [member.id, member.name],
    );
    await pool.query(
      `INSERT INTO production_member (production_id, user_id, roles, status, supervisor_id)
       VALUES ($1,$2,$3::text[],'active',$4)
       ON CONFLICT (production_id, user_id) DO UPDATE
       SET roles = EXCLUDED.roles, status = EXCLUDED.status, supervisor_id = EXCLUDED.supervisor_id`,
      [PRODUCTION_ID, member.id, member.roles, user.id],
    );
    await pool.query(
      `INSERT INTO production_dept_member (production_id, user_id, dept_id, is_poc)
       VALUES ($1,$2,$3,false)
       ON CONFLICT DO NOTHING`,
      [PRODUCTION_ID, member.id, deptRows[member.deptIndex].id],
    );
    await pool.query(
      `INSERT INTO production_member_role (production_id, user_id, role_id)
       SELECT $1,$2,id FROM production_role WHERE production_id=$1 AND name=ANY($3::text[])
       ON CONFLICT DO NOTHING`,
      [PRODUCTION_ID, member.id, member.roles],
    );
  }
  for (const approver of demoApprovers) {
    await pool.query("INSERT INTO app_user (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [approver.id]);
    await pool.query(
      `INSERT INTO user_profile (user_id, name, display_name, bio)
       VALUES ($1,$2,$2,'《雾港来信》虚拟审批演示成员')
       ON CONFLICT (user_id) DO UPDATE SET name=EXCLUDED.name, display_name=EXCLUDED.display_name, bio=EXCLUDED.bio`,
      [approver.id, approver.name],
    );
    await pool.query(
      `INSERT INTO production_member (production_id, user_id, roles, status, supervisor_id)
       VALUES ($1,$2,$3::text[],'active',$4)
       ON CONFLICT (production_id, user_id) DO UPDATE
       SET roles=EXCLUDED.roles, status=EXCLUDED.status, supervisor_id=EXCLUDED.supervisor_id`,
      [PRODUCTION_ID, approver.id, approver.roles, user.id],
    );
  }
  // 虚拟申请人的直属上级指向周衡（demoApprovers[0]）而非 owner：审批链历史
  // 写的是「周衡转交」，supervisor_id 指 owner 的话实时路由会与链矛盾——demo
  // 里新发申请算出的上级和历史里的必须是同一个人（#405 review）。两遍式落：
  // 周衡的 app_user 行在上面 approvers 循环里才建，插 demoMembers 时还引用不了。
  await pool.query(
    `UPDATE production_member SET supervisor_id = $1
     WHERE production_id = $2 AND user_id = ANY($3::uuid[])`,
    [demoApprovers[0].id, PRODUCTION_ID, demoMembers.map((m) => m.id)],
  );
  await pool.query(
    `INSERT INTO production_member_tag_assignment (production_id, user_id, tag_id)
     SELECT $1, $2, id FROM production_member_tag WHERE production_id IS NULL AND name = '正式'
     ON CONFLICT DO NOTHING`,
    [PRODUCTION_ID, user.id],
  );

  const versionResult = await pool.query<{ active_version_id: string }>(
    "SELECT active_version_id FROM production WHERE id = $1",
    [PRODUCTION_ID],
  );
  const versionId = versionResult.rows[0].active_version_id;
  // version 的 name / description / tags 已在 migrate-version-retire.sql 退役；
  // 用户看到的“本子”名称现在属于 script_view。seed 继续写旧列会在重建 demo
  // 中途失败，留下只有项目壳、没有演示内容的半成品。
  await pool.query(
    `UPDATE script_view
     SET name = '排练稿 V1'
     WHERE id = (SELECT master_view_id FROM production WHERE id = $1)`,
    [PRODUCTION_ID],
  );

  const scenes = [
    { id: "demo-scene-1", name: "雾港清晨", synopsis: "林澈在旧码头收到一封没有署名的信。", action: "寻找寄信人", music: "序曲《潮声》", duration: "08:00" },
    { id: "demo-scene-2", name: "灯塔之下", synopsis: "旧友重逢，秘密逐渐浮出水面。", action: "确认彼此的选择", music: "二重唱《灯塔不会说谎》", duration: "12:00" },
    { id: "demo-scene-3", name: "离港之前", synopsis: "全体角色在风暴前作出最终决定。", action: "完成告别并启程", music: "终曲《写给明天》", duration: "15:00" },
  ];
  for (const [index, scene] of scenes.entries()) {
    await pool.query("INSERT INTO scene (id, production_id) VALUES ($1, $2)", [scene.id, PRODUCTION_ID]);
    await pool.query(
      `INSERT INTO scene_version
         (scene_id, version_id, name, sort_order, synopsis, action_line, music, stage_notes, expected_duration)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [scene.id, versionId, scene.name, index, scene.synopsis, scene.action, scene.music, "雾效由弱至强；注意转台安全线。", scene.duration],
    );
  }

  const characters = [
    ["demo-char-lin", "林澈", "女", "年轻的航海制图师，理性而敏感。", "主角"],
    ["demo-char-zhou", "周屿", "男", "守塔人，保守着港口最后一个秘密。", "主角"],
    ["demo-char-choir", "港口众人", null, "水手、商贩与候船旅客组成的群像。", "群像"],
  ] as const;
  for (const [index, [id, name, gender, biography, roleType]] of characters.entries()) {
    await pool.query("INSERT INTO character (id, production_id) VALUES ($1, $2)", [id, PRODUCTION_ID]);
    await pool.query(
      `INSERT INTO character_version (character_id, version_id, name, sort_order, gender, biography, role_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, versionId, name, index, gender, biography, roleType],
    );
  }

  const blocks = [
    { snapshot: "demo-sn-chapter", block: "demo-chapter-1", sort: "a0", scene: null, owner: null, type: "chapter_marker", content: "", meta: { number: "第一幕", name: "潮汐来信" }, chars: [] },
    { snapshot: "demo-sn-scene-1", block: "demo-scene-1", sort: "b0", scene: "demo-scene-1", owner: null, type: "scene_marker", content: "", meta: { number: "1", name: "雾港清晨", parentMarkerId: "demo-chapter-1", synopsis: scenes[0].synopsis, actionLine: scenes[0].action, music: scenes[0].music, expectedDuration: scenes[0].duration }, chars: [] },
    { snapshot: "demo-sn-stage-1", block: "demo-block-stage-1", sort: "c0", scene: "demo-scene-1", owner: "demo-scene-1", type: "stage", content: "雾从海面漫上旧码头。远处传来第一声船笛。", meta: {}, chars: [] },
    { snapshot: "demo-sn-dialogue-1", block: "demo-block-dialogue-1", sort: "d0", scene: "demo-scene-1", owner: "demo-scene-1", type: "dialogue", content: "这封信没有日期，却知道我今天会回来。", meta: {}, chars: ["demo-char-lin"] },
    { snapshot: "demo-sn-scene-2", block: "demo-scene-2", sort: "e0", scene: "demo-scene-2", owner: null, type: "scene_marker", content: "", meta: { number: "2", name: "灯塔之下", parentMarkerId: "demo-chapter-1", synopsis: scenes[1].synopsis, actionLine: scenes[1].action, music: scenes[1].music, expectedDuration: scenes[1].duration }, chars: [] },
    { snapshot: "demo-sn-dialogue-2", block: "demo-block-dialogue-2", sort: "f0", scene: "demo-scene-2", owner: "demo-scene-2", type: "dialogue", content: "灯塔不是为了照亮过去，是为了让还在海上的人看见岸。", meta: {}, chars: ["demo-char-zhou"] },
    { snapshot: "demo-sn-scene-3", block: "demo-scene-3", sort: "g0", scene: "demo-scene-3", owner: null, type: "scene_marker", content: "", meta: { number: "3", name: "离港之前", parentMarkerId: "demo-chapter-1", synopsis: scenes[2].synopsis, actionLine: scenes[2].action, music: scenes[2].music, expectedDuration: scenes[2].duration }, chars: [] },
    { snapshot: "demo-sn-lyric-1", block: "demo-block-lyric-1", sort: "h0", scene: "demo-scene-3", owner: "demo-scene-3", type: "lyric", content: "让潮水带走旧名字，把明天写进新的航线。", meta: {}, chars: ["demo-char-lin", "demo-char-zhou", "demo-char-choir"] },
  ] as const;
  for (const block of blocks) {
    await pool.query(
      `INSERT INTO script
         (id, block_id, production_id, sort_key, scene_id, owner_marker_id, type, content, marker_meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7::block_type,$8,$9::jsonb)`,
      [block.snapshot, block.block, PRODUCTION_ID, block.sort, block.scene, block.owner, block.type, block.content, JSON.stringify(block.meta)],
    );
    await pool.query(
      "INSERT INTO script_version (snapshot_id, version_id, block_id, sort_key) VALUES ($1,$2,$3,$4)",
      [block.snapshot, versionId, block.block, block.sort],
    );
    for (const [position, characterId] of block.chars.entries()) {
      await pool.query(
        "INSERT INTO script_character (script_id, character_id, position) VALUES ($1,$2,$3)",
        [block.snapshot, characterId, position],
      );
    }
  }

  await pool.query(
    `INSERT INTO tag_group (id, production_id, name, type, sort_order) VALUES
       ('demo-tag-emotion',$1,'情绪强度','exclusive',1),
       ('demo-tag-progress',$1,'排练完成度','range',2)`,
    [PRODUCTION_ID],
  );
  await pool.query(
    `INSERT INTO tag_option (id, group_id, label, color, sort_order) VALUES
       ('demo-opt-calm','demo-tag-emotion','克制','#5f8f94',1),
       ('demo-opt-strong','demo-tag-emotion','强烈','#c66b3d',2)`,
  );
  await pool.query("UPDATE tag_group SET default_option_id='demo-opt-calm' WHERE id='demo-tag-emotion'");
  await pool.query("INSERT INTO block_tag (block_id, group_id, option_id) VALUES ('demo-block-dialogue-1','demo-tag-emotion','demo-opt-calm')");
  await pool.query("INSERT INTO block_tag (block_id, group_id, value) VALUES ('demo-block-dialogue-1','demo-tag-progress',65)");
  await pool.query(
    `INSERT INTO comment (id, production_id, context_type, context_id, user_id, author_name, body)
     VALUES ('demo-comment-1',$1,'block','demo-block-dialogue-1',$2,$3,'这里可以再停顿半拍，让信件的悬念更清楚。')`,
    [PRODUCTION_ID, user.id, user.name],
  );

  const cueLists = [
    ["demo-cuelist-lx", "灯光 Cue", "LX", "lighting"],
    ["demo-cuelist-sd", "音响 Cue", "SD", "sound"],
    ["demo-cuelist-stg", "舞台监督 Cue", "STG", "stage_management"],
  ] as const;
  for (const [id, name, abbr, template] of cueLists) {
    await pool.query(
      "INSERT INTO cue_list (id, production_id, name, abbr, notes, template, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, PRODUCTION_ID, name, abbr, "演示 Cue 表，可继续编辑与关联剧本。", template, user.id],
    );
  }
  const cues = [
    ["demo-cue-lx-1", "demo-cuelist-lx", "LX 1", "晨雾冷光", "色温 5600K，20 秒渐亮", "demo-sn-stage-1", false],
    ["demo-cue-lx-2", "demo-cuelist-lx", "LX 2", "灯塔追光", "追光从舞台左后方切入", "demo-sn-dialogue-2", true],
    ["demo-cue-sd-1", "demo-cuelist-sd", "SD 1", "海潮与船笛", "环境声由远及近", "demo-sn-stage-1", false],
    ["demo-cue-stg-1", "demo-cuelist-stg", "STG 1", "转台预备", "确认所有演员离开安全线", "demo-sn-scene-3", true],
  ] as const;
  for (const [id, listId, number, name, content, snapshot, warning] of cues) {
    await pool.query(
      `INSERT INTO cue
         (id, cue_id, cue_list_id, number, name, content, start_kind, start_snapshot_id, start_offset, end_kind, end_snapshot_id, end_offset, warning)
       VALUES ($1,$1,$2,$3,$4,$5,'block',$6,0,'block',$6,1,$7)`,
      [id, listId, number, name, content, snapshot, warning],
    );
    await pool.query("INSERT INTO cue_version (revision_id, version_id, cue_id) VALUES ($1,$2,$1)", [id, versionId]);
  }

  const weekStart = displayedWeekStart();
  const milestones = [
    ["demo-milestone-workshop", "创作工作坊", new Date(weekStart.getTime() + 6 * DAY)],
    ["demo-milestone-tech", "技术合成", new Date(weekStart.getTime() + 18 * DAY)],
    ["demo-milestone-premiere", "首演", new Date(weekStart.getTime() + 32 * DAY)],
  ] as const;
  for (const [index, [id, name, date]] of milestones.entries()) {
    await pool.query(
      "INSERT INTO milestone (id, production_id, name, end_date, sort_order) VALUES ($1,$2,$3,$4,$5)",
      [id, PRODUCTION_ID, name, date.toISOString().slice(0, 10), index],
    );
  }

  const phaseByMilestone = new Map<string, string>([
    ["demo-milestone-workshop", "demo-phase-workshop"],
    ["demo-milestone-tech", "demo-phase-tech"],
    ["demo-milestone-premiere", "demo-phase-premiere"],
  ]);
  await createPhase("demo-phase-workshop", PRODUCTION_ID, {
    name: "创作与工作坊",
    startDate: new Date(weekStart.getTime() - 14 * DAY).toISOString().slice(0, 10),
    endDate: new Date(weekStart.getTime() + 6 * DAY).toISOString().slice(0, 10),
    sortOrder: 0,
    milestoneIds: ["demo-milestone-workshop"],
  });
  await createPhase("demo-phase-tech", PRODUCTION_ID, {
    name: "技术合成",
    startDate: new Date(weekStart.getTime() + 7 * DAY).toISOString().slice(0, 10),
    endDate: new Date(weekStart.getTime() + 18 * DAY).toISOString().slice(0, 10),
    sortOrder: 1,
    milestoneIds: ["demo-milestone-tech"],
  });
  await createPhase("demo-phase-premiere", PRODUCTION_ID, {
    name: "预演与首演",
    startDate: new Date(weekStart.getTime() + 19 * DAY).toISOString().slice(0, 10),
    endDate: new Date(weekStart.getTime() + 32 * DAY).toISOString().slice(0, 10),
    sortOrder: 2,
    milestoneIds: ["demo-milestone-premiere"],
  });

  const eventSpecs = [
    { id: "demo-event-design", title: "舞美概念评审", type: "meeting", day: -10, start: 10, end: 12, location: "创作会议室", description: "确认灯塔、码头与雾幕的视觉方向。" },
    { id: "demo-event-music", title: "终曲音乐工作坊", type: "rehearsal", day: -7, start: 13, end: 17, location: "音乐排练厅", description: "完成终曲结构与合唱声部第一轮磨合。" },
    { id: "demo-event-table-read", title: "全剧围读", type: "readthrough", day: 0, start: 10, end: 13, location: "A3 排练厅", description: "围读完整剧本并记录第一轮构作问题。" },
    { id: "demo-event-vocal", title: "主角声乐排练", type: "rehearsal", day: 1, start: 10, end: 13, location: "音乐排练厅", description: "细化二重唱咬字与呼吸位置。" },
    { id: "demo-event-choreo", title: "第二场走位排练", type: "rehearsal", day: 2, start: 14, end: 18, location: "黑匣子剧场", description: "聚焦《灯塔之下》的双人走位与转台调度。" },
    { id: "demo-event-props", title: "道具桌联检", type: "meeting", day: 3, start: 10, end: 11, location: "道具间", description: "核对信件、航海图与提灯的版本和摆位。" },
    { id: "demo-event-tech", title: "灯光与音响联排", type: "tech", day: 4, start: 16, end: 21, location: "主剧场", description: "完成 LX / SD Cue 首轮联排与问题记录。" },
    { id: "demo-event-marketing", title: "宣传素材审片", type: "meeting", day: 5, start: 14, end: 16, location: "线上会议", description: "审看定妆照与首支预告片粗剪。" },
    { id: "demo-event-costume", title: "服装定妆与拍摄", type: "fitting", day: 6, start: 11, end: 15, location: "服化间", description: "完成主角定妆、服装编号与宣传素材拍摄。" },
    { id: "demo-event-act1", title: "第一幕连排", type: "rehearsal", day: 8, start: 13, end: 18, location: "主排练厅", description: "第一幕不停顿连排并记录节奏问题。" },
    { id: "demo-event-safety", title: "剧场安全培训", type: "meeting", day: 10, start: 10, end: 12, location: "主剧场", description: "完成吊杆、转台、雾机和疏散流程培训。" },
    { id: "demo-event-cue", title: "全剧 Cue-to-Cue", type: "rehearsal", day: 12, start: 14, end: 22, location: "主剧场", description: "按 Cue 顺序完成技术合成。" },
    { id: "demo-event-dress", title: "带妆彩排", type: "rehearsal", day: 16, start: 18, end: 22, location: "主剧场", description: "全要素带妆彩排与摄影记录。" },
    { id: "demo-event-preview", title: "内部预演", type: "performance", day: 20, start: 19, end: 21, location: "主剧场", description: "邀请内部观众观看并收集反馈。" },
    { id: "demo-event-premiere", title: "首演", type: "performance", day: 32, start: 19, end: 21, location: "主剧场", description: "《雾港来信》音乐剧首场演出。" },
    { id: "demo-event-completed", title: "第一轮创作汇报", type: "presentation", day: -3, start: 14, end: 17, location: "排练厅 2", description: "已完成的阶段汇报，用于展示报告与归档流程。" },
  ] as const;
  for (const spec of eventSpecs) {
    await createProductionEvent({
      id: spec.id,
      productionId: PRODUCTION_ID,
      title: spec.title,
      eventType: spec.type,
      location: spec.location,
      startTime: at(weekStart, spec.day, spec.start),
      endTime: at(weekStart, spec.day, spec.end),
      description: spec.description,
      createdBy: user.id,
      versionId,
    });
    await pool.query("UPDATE production_event SET status = $2 WHERE id = $1", [spec.id, spec.day < 0 ? "completed" : "published"]);
    await pool.query("INSERT INTO event_participant (id,event_id,user_id,name,department_id,role) VALUES ($1,$2,$3,$4,$5,'participant')", [`demo-participant-${spec.id}`, spec.id, user.id, user.name, deptRows[1].id]);
    await pool.query("INSERT INTO event_stage_manager (event_id,user_id,name) VALUES ($1,$2,$3)", [spec.id, user.id, user.name]);
  }

  const scheduleSpecs = eventSpecs.map((spec, index) => ({
    id: `demo-sched-${spec.id.replace("demo-event-", "")}`,
    eventId: spec.id,
    title: `${spec.title} · 执行流程`,
    day: spec.day,
    hour: spec.start,
    minute: 0,
    duration: Math.max(30, (spec.end - spec.start) * 60),
    location: spec.location,
    index,
  }));
  for (const spec of scheduleSpecs) {
    await createScheduleItem({
      id: spec.id,
      eventId: spec.eventId,
      title: spec.title,
      itemType: "custom",
      startTime: at(weekStart, spec.day, spec.hour, spec.minute),
      endTime: new Date(new Date(at(weekStart, spec.day, spec.hour, spec.minute)).getTime() + spec.duration * 60_000).toISOString(),
      location: spec.location,
      orderIndex: spec.index,
      targetSceneId: spec.eventId === "demo-event-choreo" ? "demo-scene-2" : null,
      targetBlockId: null,
      notes: "事件创建后自动关联的演示执行日程。",
    });
  }

  const calls = [
    ["demo-call-read", "demo-event-table-read", 0, 9, 30, "请携带排练稿与铅笔"],
    ["demo-call-choreo", "demo-event-choreo", 2, 13, 30, "提前完成身体热身"],
    ["demo-call-tech", "demo-event-tech", 4, 15, 30, "舞监台集合"],
    ["demo-call-costume", "demo-event-costume", 6, 10, 30, "素颜到场，携带基础鞋"],
  ] as const;
  for (const [id, eventId, day, hour, minute, notes] of calls) {
    await createEventCallTime({ id, eventId, userId: user.id, name: user.name, departmentId: deptRows[1].id, callAt: at(weekStart, day, hour, minute), scheduleItemId: null, notes });
  }

  const taskSpecs = [
    { id: "demo-task-script", eventId: "demo-event-table-read", title: "整理围读后的剧本修改清单", description: "按场次归纳文本、人物动机与节奏问题。", dept: deptRows[0].id, status: "in_progress", days: [0, 2], milestone: "demo-milestone-workshop" },
    { id: "demo-task-light", eventId: "demo-event-tech", title: "确认灯塔追光位与安全绳", description: "完成追光机位复测并上传现场照片。", dept: deptRows[2].id, status: "pending", days: [3, 4], milestone: "demo-milestone-tech" },
    { id: "demo-task-costume", eventId: "demo-event-costume", title: "补齐林澈第二套服装配件", description: "核对帽饰、腰带与备用纽扣。", dept: deptRows[4].id, status: "pending", days: [4, 6], milestone: "demo-milestone-workshop" },
    { id: "demo-task-sound", eventId: "demo-event-tech", title: "导出第二场环境声版本", description: "制作带低频船笛的 B 版供联排比较。", dept: deptRows[3].id, status: "done", days: [1, 3], milestone: "demo-milestone-tech" },
    { id: "demo-task-letter", eventId: "demo-event-props", title: "制作三版旧信件道具", description: "分别准备排练版、近景版与备用版。", dept: deptRows[4].id, status: "in_progress", days: [0, 3], milestone: "demo-milestone-workshop" },
    { id: "demo-task-score", eventId: "demo-event-vocal", title: "标记二重唱呼吸点", description: "同步更新钢琴谱与演员谱。", dept: deptRows[0].id, status: "pending", days: [0, 1], milestone: "demo-milestone-workshop" },
    { id: "demo-task-fog", eventId: "demo-event-cue", title: "确认雾机浓度与触发点", description: "记录三档浓度并确认演员视线安全。", dept: deptRows[2].id, status: "awaiting", days: [8, 12], milestone: "demo-milestone-tech" },
    { id: "demo-task-radio", eventId: "demo-event-cue", title: "规划无线麦频点表", description: "完成 16 路频点规划与备份频率。", dept: deptRows[3].id, status: "in_progress", days: [7, 12], milestone: "demo-milestone-tech" },
    { id: "demo-task-quickchange", eventId: "demo-event-dress", title: "测试第二幕快速换装", description: "目标在 95 秒内完成换装与复位。", dept: deptRows[4].id, status: "pending", days: [10, 16], milestone: "demo-milestone-tech" },
    { id: "demo-task-safety", eventId: "demo-event-safety", title: "整理安全培训签到表", description: "确认全体演职人员完成培训。", dept: deptRows[1].id, status: "pending", days: [8, 10], milestone: "demo-milestone-tech" },
    { id: "demo-task-preview", eventId: "demo-event-preview", title: "设计预演反馈问卷", description: "涵盖节奏、叙事清晰度与视听体验。", dept: deptRows[0].id, status: "pending", days: [14, 19], milestone: "demo-milestone-premiere" },
    { id: "demo-task-front", eventId: "demo-event-premiere", title: "确认首演前台动线", description: "核对检票、寄存、迟到观众入场规则。", dept: deptRows[1].id, status: "awaiting", days: [24, 30], milestone: "demo-milestone-premiere" },
    { id: "demo-task-program", eventId: "demo-event-premiere", title: "终校首演节目册", description: "核对演职员名单、赞助信息与版权声明。", dept: deptRows[0].id, status: "in_progress", days: [20, 28], milestone: "demo-milestone-premiere" },
    { id: "demo-task-standalone-budget", eventId: null, title: "更新技术合成预算", description: "汇总灯光、音响与耗材追加项。", dept: deptRows[1].id, status: "pending", days: [5, 9], milestone: "demo-milestone-tech" },
    { id: "demo-task-standalone-cast", eventId: null, title: "确认替补演员排班", description: "完成首演周替补与 understudy 排班。", dept: deptRows[0].id, status: "in_progress", days: [11, 15], milestone: "demo-milestone-premiere" },
    { id: "demo-task-standalone-archive", eventId: null, title: "建立首演周归档目录", description: "创建日报、照片、录像与问题单目录。", dept: deptRows[1].id, status: "pending", days: [22, 27], milestone: "demo-milestone-premiere" },
  ] as const;
  for (const task of taskSpecs) {
    await createEventTechReq({
      id: task.id,
      productionId: PRODUCTION_ID,
      eventId: task.eventId,
      scheduleItemIds: task.eventId ? [`demo-sched-${task.eventId.replace("demo-event-", "")}`] : [],
      title: task.title,
      description: task.description,
      presetMinutes: 90,
      departmentId: task.dept,
      assignees: [{ userId: user.id, name: user.name }],
      startTime: at(weekStart, task.days[0], 9),
      endTime: at(weekStart, task.days[1], 18),
      phaseIds: [phaseByMilestone.get(task.milestone)!],
      createdBy: user.id,
    });
    await pool.query("UPDATE task SET status = $2 WHERE id = $1", [task.id, task.status]);
  }

  await pool.query(
    `INSERT INTO approval_request
       (id, production_id, subject_id, type, resource_type, resource_id, resource_sub,
        permission_level, grant_type, note, status, resolved_at, resolved_by, granted_at)
     VALUES
       ('20000000-0000-4000-8000-000000000001', $1, $2, 'resource_access',
        'cue_list', 'demo-cuelist-lx', '*', 'edit', 'permanent',
        '参与技术联排，需要编辑灯光 Cue 表。', 'approved', now() - interval '4 days', $2, now() - interval '4 days')`,
    [PRODUCTION_ID, user.id],
  );

  // 时长只能取 lib/approval-ttl 的档位（服务端白名单同一份表），别写 "30 days"
  const approvalTime = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  const pendingApprovals = [
    {
      id: "20000000-0000-4000-8000-000000000002", subjectId: demoMembers[0].id,
      resourceType: "cue_list", resourceId: "demo-cuelist-lx", permissionLevel: "edit",
      grantType: "ttl", ttlDuration: "7 days", note: "灯光联排期间需要编辑 Cue 表并记录现场调整。",
      currentStage: "dept_poc", currentDepth: 0,
      chain: [
        { phase: "supervisor", stage: "supervisor", depth: 0, approverIds: [demoApprovers[0].id], notifiedAt: approvalTime(5), canFinalize: false, action: "escalated", actorId: demoApprovers[0].id, actedAt: approvalTime(4), escalationReason: "forwarded", comment: "现场需求属实，转项目管理确认权限范围。" },
        { phase: "resource", stage: "dept_poc", depth: 0, approverIds: [user.id], notifiedAt: approvalTime(4), canFinalize: true },
      ],
    },
    {
      id: "20000000-0000-4000-8000-000000000003", subjectId: demoMembers[1].id,
      resourceType: "event", resourceId: "*", permissionLevel: "publish",
      grantType: "ttl", ttlDuration: "1 mon", note: "音响组需要发布技术测试事件并同步 Call。",
      currentStage: "holder", currentDepth: 0,
      chain: [
        { phase: "supervisor", stage: "supervisor", depth: 0, approverIds: [demoApprovers[1].id], notifiedAt: approvalTime(6), canFinalize: false, action: "escalated", actorId: demoApprovers[1].id, actedAt: approvalTime(5), escalationReason: "forwarded" },
        { phase: "resource", stage: "holder", depth: 0, approverIds: [user.id], notifiedAt: approvalTime(5), canFinalize: true },
      ],
    },
    {
      id: "20000000-0000-4000-8000-000000000004", subjectId: demoMembers[2].id,
      resourceType: "scene", resourceId: "demo-scene-2", permissionLevel: "view",
      grantType: "ttl", ttlDuration: "1 day", note: "服装设计需要查看第二场文本以核对快速换装点。",
      currentStage: "owner", currentDepth: 0,
      chain: [
        { phase: "supervisor", stage: "supervisor", depth: 0, approverIds: [demoApprovers[0].id], notifiedAt: approvalTime(8), canFinalize: false, action: "escalated", actorId: demoApprovers[0].id, actedAt: approvalTime(7), escalationReason: "forwarded" },
        { phase: "resource", stage: "dept_poc", depth: 0, approverIds: [demoApprovers[1].id], notifiedAt: approvalTime(7), canFinalize: true, action: "escalated", actorId: demoApprovers[1].id, actedAt: approvalTime(6), escalationReason: "forwarded", comment: "涉及未公开文本，提交 Owner 终审。" },
        { phase: "resource", stage: "owner", depth: 0, approverIds: [user.id], notifiedAt: approvalTime(6), canFinalize: true },
      ],
    },
    {
      id: "20000000-0000-4000-8000-000000000005", subjectId: demoMembers[3].id,
      resourceType: "scene", resourceId: "*", permissionLevel: "view",
      grantType: "permanent", ttlDuration: null, note: "演员申请长期查看排练文本。",
      currentStage: "producer", currentDepth: 0,
      chain: [
        { phase: "supervisor", stage: "supervisor", depth: 0, approverIds: [demoApprovers[0].id], notifiedAt: approvalTime(9), canFinalize: false, action: "escalated", actorId: demoApprovers[0].id, actedAt: approvalTime(8), escalationReason: "forwarded" },
        { phase: "resource", stage: "producer", depth: 0, approverIds: [user.id], notifiedAt: approvalTime(8), canFinalize: true },
      ],
    },
  ] as const;
  for (const approval of pendingApprovals) {
    // 收件箱（listPendingApprovals）与鉴权只读 current_approver_ids / current_stage，
    // 不再解析 escalation_chain——只写链的话这几条待办一条都不会出现在待办列表里。
    await pool.query(
      `INSERT INTO approval_request
         (id, production_id, subject_id, type, resource_type, resource_id, resource_sub,
          permission_level, grant_type, ttl_duration, note, status,
          current_stage, current_stage_depth, current_approver_ids, escalation_chain, created_at)
       VALUES ($1,$2,$3,'resource_access',$4,$5,'*',$6,$7,$8::interval,$9,'pending_resource',
               $10,$11,ARRAY[$12]::uuid[],$13::jsonb,now() - interval '10 hours')`,
      [
        approval.id, PRODUCTION_ID, approval.subjectId, approval.resourceType, approval.resourceId,
        approval.permissionLevel, approval.grantType, approval.ttlDuration, approval.note,
        approval.currentStage, approval.currentDepth, user.id, JSON.stringify(approval.chain),
      ],
    );
  }

  await createAnnouncement("demo-announcement-risk", PRODUCTION_ID, "技术联排安全提醒", "周五进入主剧场前请完成安全培训签到。追光桥与吊杆区未经许可不得进入。", user.id);
  await updateAnnouncement("demo-announcement-risk", PRODUCTION_ID, { isPinned: true });
  await createAnnouncement("demo-announcement-script", PRODUCTION_ID, "排练稿 V1 已发布", "新的排练稿已包含第二场结尾调整，请各部门在下一次排练前完成版本确认。", user.id);
  await createAnnouncement("demo-announcement-fitting", PRODUCTION_ID, "周日定妆安排", "服装、妆发与宣传拍摄将在同一时段进行，请按 Call Sheet 到场。", user.id);

  const concept = await createWiki({ productionId: PRODUCTION_ID, title: "创作概念与视觉关键词", body: "# 创作概念\n\n关键词：雾、信件、灯塔、离港。\n\n舞台空间以可旋转的旧码头平台为核心，灯塔既是方向也是角色内心的隐喻。", createdBy: user.id });
  const rehearsal = await createWiki({ productionId: PRODUCTION_ID, title: "排练笔记｜第二场", body: "# 第二场排练笔记\n\n- 二重唱前半段保持人物距离\n- 第 32 小节后开始靠近灯塔\n- 转台启动前由舞监二次确认安全线", createdBy: user.id });
  await pool.query("INSERT INTO wiki_tag (wiki_id,tag) VALUES ($1,'创作'),($1,'视觉'),($2,'排练'),($2,'第二场')", [concept.id, rehearsal.id]);

  const publishedReport = await createEventReport({ id: "demo-report-round1", eventId: "demo-event-completed", reportType: "rehearsal", title: "第一轮创作汇报记录", body: "# 总结\n\n完成三场核心段落的初步呈现。观众反馈集中在第二场人物关系与终曲情绪递进。\n\n## 下一步\n\n1. 缩短第一场信息铺垫\n2. 强化灯塔意象\n3. 补充技术测试", createdBy: user.id });
  await pool.query("UPDATE event_report SET published_at = now() - interval '2 days' WHERE id = $1", [publishedReport.id]);
  await createEventReport({ id: "demo-report-tech-draft", eventId: "demo-event-completed", reportType: "technical", title: "技术问题汇总（草稿）", body: "# 待补充\n\n- 转台噪声\n- 追光角度\n- 无线麦频点规划", createdBy: user.id });

  await createAsset({ productionId: PRODUCTION_ID, uploaderUserId: user.id, assetType: "drafting", name: "舞台平面图 V3", fileName: "misty-harbor-stage-plan-v3.pdf", mimeType: "application/pdf", isPublic: false, storageType: "feishu_link", feishuUrl: "https://example.com/demo/stage-plan", fileSize: 2_480_000 });
  await createAsset({ productionId: PRODUCTION_ID, uploaderUserId: user.id, assetType: "demo", name: "终曲编曲 Demo", fileName: "tomorrow-arrangement-demo.mp3", mimeType: "audio/mpeg", isPublic: false, storageType: "feishu_link", feishuUrl: "https://example.com/demo/finale", fileSize: 8_120_000 });
  await createAsset({ productionId: PRODUCTION_ID, uploaderUserId: user.id, assetType: "reference", name: "灯塔视觉参考", fileName: "lighthouse-reference.jpg", mimeType: "image/jpeg", isPublic: true, storageType: "feishu_link", feishuUrl: "https://example.com/demo/lighthouse", fileSize: 980_000 });

  await createUserNotification({ userId: user.id, productionId: PRODUCTION_ID, kind: "call_reminder", entityType: "event", entityId: "demo-event-table-read", title: "全剧围读 Call 已发布", body: "周一 09:30 · A3 排练厅", viewHref: `/production/${PRODUCTION_ID}/events/demo-event-table-read/callsheet`, category: "info" });
  await createUserNotification({ userId: user.id, productionId: PRODUCTION_ID, kind: "task_due", entityType: "task", entityId: "demo-task-light", title: "灯塔追光任务临近截止", body: "请在技术联排前完成机位与安全绳确认。", viewHref: `/production/${PRODUCTION_ID}/tasks/demo-task-light`, category: "warning", actionRequired: true });
  await createUserNotification({ userId: user.id, productionId: PRODUCTION_ID, kind: "script_update", entityType: "version", entityId: versionId, title: "排练稿 V1 已更新", body: "第二场结尾与终曲歌词已调整。", viewHref: `/production/${PRODUCTION_ID}/script?v=${versionId}`, category: "action" });

  // ── 物料台账 ────────────────────────────────────────────────────────────────
  // 状态按 order_index 取，不写状态名：系统预设可能改名，剧组也能加自己的状态
  // （db/add-material-ledger.sql 的立意是「自由列表不是状态机」）。
  const statuses = await listMaterialStatuses(PRODUCTION_ID);
  const st = (i: number) => statuses[i % statuses.length]?.id ?? null;
  const demoMaterials: [string, string, string, number, number, string][] = [
    ["PR-014", "旧式黄铜航海罗盘", "道具", 0, 0, "A-03"],
    ["CS-021", "林澈第二场深蓝风衣", "服装", 3, 1, "C-12"],
    ["EQ-008", "手持船笛效果器", "设备", 2, 2, "主剧场"],
    ["SC-005", "灯塔栏杆模块", "布景", 1, 3, "制作工坊"],
    ["PR-019", "无署名旧信件（8 份）", "道具", 0, 0, "A-07"],
  ];
  for (const [code, mName, category, statusIdx, deptIdx, location] of demoMaterials) {
    await createMaterial({
      productionId: PRODUCTION_ID, code, name: mName, category,
      subject: { kind: "dept", id: deptRows[deptIdx].id },
      statusId: st(statusIdx), location, quantity: 1, createdBy: user.id,
    });
  }

  // ── 财务 ────────────────────────────────────────────────────────────────────
  // 金额是字符串（NUMERIC(14,2)，见 lib/money.ts 的由来）。挂 deptId 会同时往
  // resource_dept_manage 写一行，于是该部门 POC 自动成为这条预算线的审批人。
  const demoCategories: [string, string, number][] = [
    ["创作与版权", "120000.00", 0],
    ["舞美制作", "280000.00", 1],
    ["演员与排练", "190000.00", 2],
    ["宣传与场租", "160000.00", 3],
  ];
  const catIds: string[] = [];
  for (const [cName, amount, deptIdx] of demoCategories) {
    const cat = await createBudgetCategory({
      productionId: PRODUCTION_ID, name: cName, amount,
      deptId: deptRows[deptIdx].id, orderIndex: catIds.length, createdBy: user.id,
    });
    catIds.push(cat.id);
  }

  // 支出走 submitExpense 而不是直接 INSERT——它会跑 buildApprovalLadder 把
  // current_approver_ids 算出来，收件箱和授权判定都读那一列。绕过它造出来的行
  // 在库里看着没问题，在收件箱里却永远不出现。
  //
  // 最后一列是「是否批掉」。必须留几笔已批的：BudgetCategory.spent 只统计
  // **已批准**的支出，全是 pending 的话财务页会是「已使用 ¥0 + 四条空进度条」，
  // 看着像功能坏了。也必须留几笔待审批的，否则收件箱里没有可演示的待办。
  const demoExpenses: [string, number, string, boolean][] = [
    ["剧本改编版权金", 0, "42000.00", true],
    ["终曲编曲首付款", 0, "18000.00", true],
    ["作曲尾款", 0, "12400.00", true],
    ["灯塔主体结构制作", 1, "96000.00", true],
    ["转台租赁（技术周）", 1, "48900.00", true],
    ["布景喷绘", 1, "24000.00", true],
    ["舞台模型材料", 1, "8600.00", false],
    ["演员排练津贴（三月）", 2, "68000.00", true],
    ["形体指导课时", 2, "16500.00", true],
    ["A3 排练厅场租", 2, "12000.00", true],
    ["主视觉设计", 3, "18200.00", true],
    ["首演场地定金", 3, "25000.00", true],
    ["预告片拍摄", 3, "32000.00", false],
  ];
  for (const [title, catIdx, amount, approve] of demoExpenses) {
    const exp = await submitExpense({
      productionId: PRODUCTION_ID, categoryId: catIds[catIdx], title, amount,
      note: "", submittedBy: user.id,
    });
    if (!approve) continue;
    // 阶梯可能要走好几级（直属上级 → 资源持有者 → 共管部门 POC → …），
    // approve 返回 forwarded=true 就是「转给下一级了」，得继续推到终局。
    // 上限只是防呆：阶梯是有限的，真转不完说明 nextStage 出了问题。
    for (let i = 0; i < 8; i++) {
      const r = await approveExpense(exp.id, PRODUCTION_ID, user.id);
      if (!r.ok || !r.forwarded) break;
    }
  }

  const summary = await pool.query<{ table_name: string; count: string }>(
    `SELECT 'projects' AS table_name, count(*)::text AS count FROM production WHERE id = $1
     UNION ALL SELECT 'script blocks', count(*)::text FROM script WHERE production_id = $1
     UNION ALL SELECT 'scenes', count(*)::text FROM scene WHERE production_id = $1
     UNION ALL SELECT 'characters', count(*)::text FROM character WHERE production_id = $1
     UNION ALL SELECT 'cues', count(*)::text FROM cue c JOIN cue_list cl ON cl.id=c.cue_list_id WHERE cl.production_id = $1
     UNION ALL SELECT 'events', count(*)::text FROM production_event WHERE production_id = $1
     UNION ALL SELECT 'tasks', count(*)::text FROM task WHERE production_id = $1
     UNION ALL SELECT 'wiki docs', count(*)::text FROM wiki WHERE production_id = $1
     UNION ALL SELECT 'reports', count(*)::text FROM event_report er JOIN production_event pe ON pe.id=er.event_id WHERE pe.production_id = $1
     UNION ALL SELECT 'announcements', count(*)::text FROM production_announcement WHERE production_id = $1
     UNION ALL SELECT 'assets', count(*)::text FROM asset WHERE production_id = $1
     UNION ALL SELECT 'notifications', count(*)::text FROM user_notification WHERE production_id = $1
     UNION ALL SELECT 'materials', count(*)::text FROM production_material WHERE production_id = $1
     UNION ALL SELECT 'budget categories', count(*)::text FROM production_budget_category WHERE production_id = $1
     UNION ALL SELECT 'expenses', count(*)::text FROM production_expense WHERE production_id = $1
     UNION ALL SELECT '  · approved', count(*)::text FROM production_expense WHERE production_id = $1 AND status = 'approved'
     UNION ALL SELECT '  · pending', count(*)::text FROM production_expense WHERE production_id = $1 AND status = 'pending'`,
    [PRODUCTION_ID],
  );
  console.log(`Demo project ready for ${user.name}: /production/${PRODUCTION_ID}`);
  for (const row of summary.rows) console.log(`  ${row.table_name}: ${row.count}`);
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
