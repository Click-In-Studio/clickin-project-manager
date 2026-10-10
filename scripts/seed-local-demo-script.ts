import { getPool } from "../lib/pg";
import { ensureSceneAnchorsInTx, insertSnapshotRowsInTx, snapshotRowFromBlock, upsertCharacterRowsInTx } from "../lib/script/script-row-tx";
import { patchCharacterMeta } from "../lib/script/script-scene-character-db";
import { finalizeMarkerInvariantsInTx, markerStructureBlocksInTx } from "../lib/script/script-marker-tx";

/** 演示项目的剧本造数；独立验证标记写入，不依赖演示项目其他模块。 */
export async function seedLocalDemoScript(productionId: string, versionId: string): Promise<void> {
  const pool = getPool();
  const scenes = [
    { id: "demo-scene-1", name: "雾港清晨", synopsis: "林澈在旧码头收到一封没有署名的信。", action: "寻找寄信人", music: "序曲《潮声》", duration: "08:00" },
    { id: "demo-scene-2", name: "灯塔之下", synopsis: "旧友重逢，秘密逐渐浮出水面。", action: "确认彼此的选择", music: "二重唱《灯塔不会说谎》", duration: "12:00" },
    { id: "demo-scene-3", name: "离港之前", synopsis: "全体角色在风暴前作出最终决定。", action: "完成告别并启程", music: "终曲《写给明天》", duration: "15:00" },
  ];
  const characters = [
    ["demo-char-lin", "林澈", "女", "年轻的航海制图师，理性而敏感。", "主角"],
    ["demo-char-zhou", "周屿", "男", "守塔人，保守着港口最后一个秘密。", "主角"],
    ["demo-char-choir", "港口众人", null, "水手、商贩与候船旅客组成的群像。", "群像"],
  ] as const;
  const blocks = [
    { snapshot: "demo-sn-chapter", block: "demo-chapter-1", sort: "a0", scene: "demo-chapter-1", owner: null, type: "chapter_marker", content: "", meta: { number: "第一幕", name: "潮汐来信" }, chars: [] },
    { snapshot: "demo-sn-scene-1", block: "demo-scene-1", sort: "b0", scene: "demo-scene-1", owner: null, type: "scene_marker", content: "", meta: { number: "1", name: "雾港清晨", parentMarkerId: "demo-chapter-1", synopsis: scenes[0].synopsis, actionLine: scenes[0].action, music: scenes[0].music, stageNotes: "雾效由弱至强；注意转台安全线。", expectedDuration: scenes[0].duration }, chars: [] },
    { snapshot: "demo-sn-stage-1", block: "demo-block-stage-1", sort: "c0", scene: "demo-scene-1", owner: "demo-scene-1", type: "stage", content: "雾从海面漫上旧码头。远处传来第一声船笛。", meta: {}, chars: [] },
    { snapshot: "demo-sn-dialogue-1", block: "demo-block-dialogue-1", sort: "d0", scene: "demo-scene-1", owner: "demo-scene-1", type: "dialogue", content: "这封信没有日期，却知道我今天会回来。", meta: {}, chars: ["demo-char-lin"] },
    { snapshot: "demo-sn-scene-2", block: "demo-scene-2", sort: "e0", scene: "demo-scene-2", owner: null, type: "scene_marker", content: "", meta: { number: "2", name: "灯塔之下", parentMarkerId: "demo-chapter-1", synopsis: scenes[1].synopsis, actionLine: scenes[1].action, music: scenes[1].music, stageNotes: "雾效由弱至强；注意转台安全线。", expectedDuration: scenes[1].duration }, chars: [] },
    { snapshot: "demo-sn-dialogue-2", block: "demo-block-dialogue-2", sort: "f0", scene: "demo-scene-2", owner: "demo-scene-2", type: "dialogue", content: "灯塔不是为了照亮过去，是为了让还在海上的人看见岸。", meta: {}, chars: ["demo-char-zhou"] },
    { snapshot: "demo-sn-scene-3", block: "demo-scene-3", sort: "g0", scene: "demo-scene-3", owner: null, type: "scene_marker", content: "", meta: { number: "3", name: "离港之前", parentMarkerId: "demo-chapter-1", synopsis: scenes[2].synopsis, actionLine: scenes[2].action, music: scenes[2].music, stageNotes: "雾效由弱至强；注意转台安全线。", expectedDuration: scenes[2].duration }, chars: [] },
    { snapshot: "demo-sn-lyric-1", block: "demo-block-lyric-1", sort: "h0", scene: "demo-scene-3", owner: "demo-scene-3", type: "lyric", content: "让潮水带走旧名字，把明天写进新的航线。", meta: {}, chars: ["demo-char-lin", "demo-char-zhou", "demo-char-choir"] },
  ] as const;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [versionId]);
    const previousMarkerStructure = await markerStructureBlocksInTx(client, versionId);
    await upsertCharacterRowsInTx(client, productionId, versionId,
      characters.map(([id, name], sortOrder) => ({ id, name, sortOrder, isAggregate: false })));
    const rows = blocks.map(block => snapshotRowFromBlock({
      id: block.block, type: block.type === "lyric" ? "dialogue" : block.type, content: block.content, characterIds: [...block.chars],
      characterAnnotations: {}, lyric: block.type === "lyric", sceneId: block.scene,
      rehearsalMark: null, ownerMarkerId: block.owner, markerMeta: block.meta,
    }, { snapshotId: block.snapshot, blockId: block.block, lexKey: block.sort }));
    await ensureSceneAnchorsInTx(client, productionId,
      blocks.filter(block => block.type === "chapter_marker" || block.type === "scene_marker").map(block => block.block));
    await insertSnapshotRowsInTx(client, productionId, versionId, rows);
    // scene_version 只从标记派生；身份锚、归属和详情在同一事务内完成。
    await finalizeMarkerInvariantsInTx(client, productionId, versionId, { mode: "full", previousMarkerStructure });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  for (const [id, , gender, biography, roleType] of characters) {
    await patchCharacterMeta(id, versionId, { ...(gender === null ? {} : { gender }), biography, roleType });
  }
}
