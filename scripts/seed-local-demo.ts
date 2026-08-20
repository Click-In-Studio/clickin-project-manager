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
    // 显示名走 user_profile（identity 层），不再 join feishu_user——PR #234 之后
    // feishu_user 只是同步源，不是取名的路径。
    `SELECT au.id, COALESCE(NULLIF(up.display_name, ''), up.name, '本地用户') AS name
     FROM app_user au
     LEFT JOIN user_profile up ON up.user_id = au.id
     ORDER BY au.created_at DESC
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
  ].map((member, index) => ({ ...member, roles: [projectRoles[index % projectRoles.length]] }));

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
  await pool.query(
    "UPDATE version SET name = '排练稿 V1', description = '演示剧本：含章节、场次、角色、舞台提示与对白', tags = ARRAY['演示','排练稿'] WHERE id = $1",
    [versionId],
  );

  const scenes = [
    { id: "demo-scene-1", num: "1", name: "雾港清晨", synopsis: "林澈在旧码头收到一封没有署名的信。", action: "寻找寄信人", music: "序曲《潮声》", duration: "08:00" },
    { id: "demo-scene-2", num: "2", name: "灯塔之下", synopsis: "旧友重逢，秘密逐渐浮出水面。", action: "确认彼此的选择", music: "二重唱《灯塔不会说谎》", duration: "12:00" },
    { id: "demo-scene-3", num: "3", name: "离港之前", synopsis: "全体角色在风暴前作出最终决定。", action: "完成告别并启程", music: "终曲《写给明天》", duration: "15:00" },
  ];
  for (const [index, scene] of scenes.entries()) {
    await pool.query("INSERT INTO scene (id, production_id) VALUES ($1, $2)", [scene.id, PRODUCTION_ID]);
    await pool.query(
      `INSERT INTO scene_version
         (scene_id, version_id, num, name, sort_order, synopsis, action_line, music, stage_notes, expected_duration)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [scene.id, versionId, scene.num, scene.name, index, scene.synopsis, scene.action, scene.music, "雾效由弱至强；注意转台安全线。", scene.duration],
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
      milestoneIds: [task.milestone],
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
  const pendingApprovals = [
    ["20000000-0000-4000-8000-000000000002", demoMembers[0].id, "cue_list", "demo-cuelist-lx", "edit", "ttl", "7 days", "灯光联排期间需要编辑 Cue 表并记录现场调整。"],
    ["20000000-0000-4000-8000-000000000003", demoMembers[1].id, "event", "*", "publish", "ttl", "1 mon", "音响组需要发布技术测试事件并同步 Call。"],
    ["20000000-0000-4000-8000-000000000004", demoMembers[2].id, "scene", "demo-scene-2", "view", "ttl", "1 day", "服装设计需要查看第二场文本以核对快速换装点。"],
    ["20000000-0000-4000-8000-000000000005", demoMembers[3].id, "scene", "*", "view", "permanent", null, "演员申请长期查看排练文本。"],
  ] as const;
  for (const [id, subjectId, resourceType, resourceId, permissionLevel, grantType, ttlDuration, note] of pendingApprovals) {
    // 收件箱（listPendingApprovals）与鉴权只读 current_approver_ids / current_stage，
    // 不再解析 escalation_chain——只写链的话这几条待办一条都不会出现在待办列表里。
    await pool.query(
      `INSERT INTO approval_request
         (id, production_id, subject_id, type, resource_type, resource_id, resource_sub,
          permission_level, grant_type, ttl_duration, note, status,
          current_stage, current_stage_depth, current_approver_ids, escalation_chain, created_at)
       VALUES ($1,$2,$3,'resource_access',$4,$5,'*',$6,$7,$8::interval,$9,'pending_supervisor',
               'supervisor',0,ARRAY[$11]::uuid[],$10::jsonb,now() - interval '2 hours')`,
      [id, PRODUCTION_ID, subjectId, resourceType, resourceId, permissionLevel, grantType, ttlDuration, note,
       JSON.stringify([{ phase: "supervisor", approverIds: [user.id], notifiedAt: new Date().toISOString() }]),
       user.id],
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

  await createAsset({ productionId: PRODUCTION_ID, uploaderUserId: user.id, assetType: "drafting", name: "舞台平面图 V3", fileName: "misty-harbor-stage-plan-v3.pdf", mimeType: "application/pdf", isUniversal: true, isPublic: false, storageType: "feishu_link", feishuUrl: "https://example.com/demo/stage-plan", fileSize: 2_480_000, versionId });
  await createAsset({ productionId: PRODUCTION_ID, uploaderUserId: user.id, assetType: "demo", name: "终曲编曲 Demo", fileName: "tomorrow-arrangement-demo.mp3", mimeType: "audio/mpeg", isUniversal: false, isPublic: false, storageType: "feishu_link", feishuUrl: "https://example.com/demo/finale", fileSize: 8_120_000, versionId });
  await createAsset({ productionId: PRODUCTION_ID, uploaderUserId: user.id, assetType: "reference", name: "灯塔视觉参考", fileName: "lighthouse-reference.jpg", mimeType: "image/jpeg", isUniversal: true, isPublic: true, storageType: "feishu_link", feishuUrl: "https://example.com/demo/lighthouse", fileSize: 980_000, versionId });

  await createUserNotification({ userId: user.id, productionId: PRODUCTION_ID, kind: "call_reminder", entityType: "event", entityId: "demo-event-table-read", title: "全剧围读 Call 已发布", body: "周一 09:30 · A3 排练厅", viewHref: `/production/${PRODUCTION_ID}/events/demo-event-table-read/callsheet`, category: "info" });
  await createUserNotification({ userId: user.id, productionId: PRODUCTION_ID, kind: "task_due", entityType: "task", entityId: "demo-task-light", title: "灯塔追光任务临近截止", body: "请在技术联排前完成机位与安全绳确认。", viewHref: `/production/${PRODUCTION_ID}/tasks/demo-task-light`, category: "warning", actionRequired: true });
  await createUserNotification({ userId: user.id, productionId: PRODUCTION_ID, kind: "script_update", entityType: "version", entityId: versionId, title: "排练稿 V1 已更新", body: "第二场结尾与终曲歌词已调整。", viewHref: `/production/${PRODUCTION_ID}/script?v=${versionId}`, category: "action" });

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
     UNION ALL SELECT 'notifications', count(*)::text FROM user_notification WHERE production_id = $1`,
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
