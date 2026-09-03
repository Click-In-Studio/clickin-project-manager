-- 角色模版漂移回填：把存量演出的角色区间对齐当前模版（2026-09-03）。
--
-- 三笔账一次清（线上 11 个演出实查的差集，18 枚键约 1150 行）：
--   ① 基线演进未回填——finance/*/categories@view、finance/*/expenses@create、
--      material/*@view、phase/*@view 四枚是模版建制之后才进 OPEN_BASELINE 的，
--      9 个存量演出的全部角色都没有。
--   ② 作曲 / 编曲 挂不了谱子与 demo——scene 与 script 两侧的 mounts@create 线上
--      11/11 全无，而构作页的挂载入口是粗门（持 music@edit 即亮），点下去 403。
--      上传那枚是双保险：本该走创作组部门区间，但剧组未必把作曲编进音乐部门。
--   ③ 角色键漂移——8 个模版建制之前的演出：设计族/音乐族/舞监缺 cue_list/*@create，
--      舞台监督缺 event 与 task 那七枚，制作助理缺 phase 写面三枚。
--
-- **只加不删**（用户 2026-09-03 定：存量不收权限、只放权限）。全文没有一处 DELETE：
-- 剧组手工加过的键、模版裁剪掉而存量还留着的键，一律原样保留。
--
-- 补的是**资格区间**不是访问权：成员仍经激活面自确认落 production_member_grant 行。
-- 三段的键都在 PAGE_PERMISSION_SCOPES 目录里，落得下去（批D/E 的教训：模版发了
-- 而激活面没收的键，区间永远变不成行）。
--
-- 两条排除，三段共用：
--   · 弃用角色不补（沿用 migrate-asset-upload-zone-backfill 的口径）
--   · 持 node:*/*@* 的角色不补——制作人的通配全集已覆盖一切
--
-- 键表是**当次快照**：模版此后再演进不会自动流到这里，下一次漂移另起一支
-- （迁移文件一经 commit 即冻结，见 AGENTS.md）。幂等，可重复执行。
--
-- 跨 commit 自足守卫（词汇行，add-rest-verbs.sql 镜像）：
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('scene',  'create', 0),
  ('script', 'create', 0),
  ('asset',  'create', 0)
ON CONFLICT DO NOTHING;

BEGIN;

-- ── ① 基线：合并进**每个**角色的行集（含剧组自建的角色名）───────────────────
-- 影视类（FILM_BASELINE 极简）与一人项目（基线为空）是刻意收紧的，排除在外——
-- 给它们推开放基线等于推翻模版的有意设计。
INSERT INTO production_role_permission (role_id, permission_key)
SELECT r.id, k.permission_key
FROM production_role r
JOIN production p ON p.id = r.production_id
CROSS JOIN (VALUES
  ('node:announcement/*@view'),
  ('node:asset/*/file@view'),
  ('node:asset/*/meta@view'),
  ('node:asset/*/shares@create'),
  ('node:character/*/biography@view'),
  ('node:character/*/gender@view'),
  ('node:character/*/members@view'),
  ('node:character/*/meta@view'),
  ('node:character/*/role_type@view'),
  ('node:cue_list/*/cues@view'),
  ('node:cue_list/*/cues/comments@create'),
  ('node:cue_list/*/meta@view'),
  ('node:event/*/details@view'),
  ('node:event/*/followers@create'),
  ('node:event/*/meta@view'),
  ('node:finance/*/categories@view'),
  ('node:finance/*/expenses@create'),
  ('node:material/*@view'),
  ('node:member/*/contact@view'),
  ('node:member/*/meta@view'),
  ('node:milestone/*@view'),
  ('node:phase/*@view'),
  ('node:production/*/meta@view'),
  ('node:production/*/mounts@view'),
  ('node:scene/*/action_line@view'),
  ('node:scene/*/meta@view'),
  ('node:scene/*/music@view'),
  ('node:scene/*/stage_notes@view'),
  ('node:scene/*/synopsis@view'),
  ('node:script/*/blocks@view'),
  ('node:script/*/comments@create'),
  ('node:wiki/*@create')
) AS k(permission_key)
WHERE NOT r.is_deprecated
  -- 持通配全集的角色跳过：制作人的 node:*/*@* 已覆盖一切，补字面键纯噪音
  AND NOT EXISTS (
    SELECT 1 FROM production_role_permission w
    WHERE w.role_id = r.id AND w.permission_key = 'node:*/*@*'
  )
  AND (p.type IS NULL OR p.type NOT IN ('short_film', 'film', 'tv_drama', 'solo', 'other'))
ON CONFLICT DO NOTHING;

-- ── ② 作曲 / 编曲 的挂载与上传：四套模版都发，故不限演出类型 ─────────────────
INSERT INTO production_role_permission (role_id, permission_key)
SELECT r.id, k.permission_key
FROM production_role r
JOIN (VALUES
  ('作曲', 'node:scene/*/mounts@create'),
  ('作曲', 'node:script/*/mounts@create'),
  ('作曲', 'node:asset/*@create'),
  ('编曲', 'node:scene/*/mounts@create'),
  ('编曲', 'node:script/*/mounts@create'),
  ('编曲', 'node:asset/*@create')
) AS k(role_name, permission_key) ON k.role_name = r.name
WHERE NOT r.is_deprecated
  -- 持通配全集的角色跳过：制作人的 node:*/*@* 已覆盖一切，补字面键纯噪音
  AND NOT EXISTS (
    SELECT 1 FROM production_role_permission w
    WHERE w.role_id = r.id AND w.permission_key = 'node:*/*@*'
  )
ON CONFLICT DO NOTHING;

-- ── ③ 戏剧模版的逐角色附加键（基线之外的那部分）─────────────────────────────
-- 仅限解析到戏剧模版的演出（type 为空时 resolveTemplate 回落戏剧）——音乐类 /
-- 广播剧类的同名岗位是另一套等级（同名不同级，见 lib/templates/music.ts 文件头），
-- 拿戏剧那份去对齐会越权。
INSERT INTO production_role_permission (role_id, permission_key)
SELECT r.id, k.permission_key
FROM production_role r
JOIN production p ON p.id = r.production_id
JOIN (VALUES
  ('编舞', 'node:script/*/rehearsal_marks@view'),
  ('编舞', 'node:script/*/rehearsal_marks@create'),
  ('编舞', 'node:script/*/rehearsal_marks@edit'),
  ('编舞', 'node:script/*/rehearsal_marks@delete'),
  ('编舞', 'node:script/*/rehearsal_marks/position@edit'),
  ('编舞', 'node:scene/*/action_line@edit'),
  ('编舞', 'node:task/*@view'),
  ('舞台监督', 'node:cue_list/*@create'),
  ('舞台监督', 'node:event/*@create'),
  ('舞台监督', 'node:event/*@view'),
  ('舞台监督', 'node:event/*/call_sheet@view'),
  ('舞台监督', 'node:event/*/chat@create'),
  ('舞台监督', 'node:event/*/publication@create'),
  ('舞台监督', 'node:event/*/publication@delete'),
  ('舞台监督', 'node:event/*/publication@view'),
  ('舞台监督', 'node:event/*/reports@view'),
  ('舞台监督', 'node:report/*@delete'),
  ('舞台监督', 'node:task/*@delete'),
  ('舞台监督', 'node:task/*@view'),
  ('后台舞台监督', 'node:event/*@view'),
  ('后台舞台监督', 'node:event/*/publication@create'),
  ('后台舞台监督', 'node:event/*/publication@delete'),
  ('后台舞台监督', 'node:report/*@delete'),
  ('制作助理', 'node:announcement/*@create'),
  ('制作助理', 'node:announcement/*@delete'),
  ('制作助理', 'node:announcement/*@edit'),
  ('制作助理', 'node:milestone/*@create'),
  ('制作助理', 'node:milestone/*@delete'),
  ('制作助理', 'node:milestone/*@edit'),
  ('制作助理', 'node:phase/*@create'),
  ('制作助理', 'node:phase/*@delete'),
  ('制作助理', 'node:phase/*@edit'),
  ('制作助理', 'node:task/*@view'),
  ('编剧', 'node:character/*@create'),
  ('编剧', 'node:character/*@delete'),
  ('编剧', 'node:character/*@edit'),
  ('编剧', 'node:scene/*@create'),
  ('编剧', 'node:scene/*@delete'),
  ('编剧', 'node:scene/*@edit'),
  ('编剧', 'node:scene/*/action_line@edit'),
  ('编剧', 'node:scene/*/meta/expected_duration@edit'),
  ('编剧', 'node:scene/*/meta/name@edit'),
  ('编剧', 'node:scene/*/meta/type@edit'),
  ('编剧', 'node:scene/*/stage_notes@edit'),
  ('编剧', 'node:scene/*/synopsis@edit'),
  ('编剧', 'node:script/*/blocks@create'),
  ('编剧', 'node:script/*/blocks@delete'),
  ('编剧', 'node:script/*/blocks@edit'),
  ('编剧', 'node:script/*/blocks/character@edit'),
  ('编剧', 'node:script/*/blocks/position@edit'),
  ('编剧', 'node:script/*/blocks/tags@edit'),
  ('编剧', 'node:script/*/blocks/type@edit'),
  ('编剧', 'node:script/*/mounts@create'),
  ('编剧', 'node:script/*/rehearsal_marks@create'),
  ('编剧', 'node:script/*/rehearsal_marks@delete'),
  ('编剧', 'node:script/*/rehearsal_marks@edit'),
  ('编剧', 'node:script/*/rehearsal_marks@view'),
  ('编剧', 'node:script/*/rehearsal_marks/position@edit'),
  ('编剧', 'node:tag_group/*@create'),
  ('编剧', 'node:tag_group/*@delete'),
  ('编剧', 'node:tag_group/*@edit'),
  ('编剧', 'node:tag_group/*/options@create'),
  ('编剧', 'node:tag_group/*/options@delete'),
  ('戏剧构作', 'node:character/*@create'),
  ('戏剧构作', 'node:character/*@delete'),
  ('戏剧构作', 'node:character/*@edit'),
  ('戏剧构作', 'node:scene/*@create'),
  ('戏剧构作', 'node:scene/*@delete'),
  ('戏剧构作', 'node:scene/*@edit'),
  ('戏剧构作', 'node:scene/*/action_line@edit'),
  ('戏剧构作', 'node:scene/*/meta/expected_duration@edit'),
  ('戏剧构作', 'node:scene/*/meta/name@edit'),
  ('戏剧构作', 'node:scene/*/meta/type@edit'),
  ('戏剧构作', 'node:scene/*/stage_notes@edit'),
  ('戏剧构作', 'node:scene/*/synopsis@edit'),
  ('戏剧构作', 'node:tag_group/*@create'),
  ('戏剧构作', 'node:tag_group/*@delete'),
  ('戏剧构作', 'node:tag_group/*@edit'),
  ('戏剧构作', 'node:tag_group/*/options@create'),
  ('戏剧构作', 'node:tag_group/*/options@delete'),
  ('导演', 'node:dept/*/notes@create'),
  ('导演', 'node:event/*/publication@view'),
  ('导演', 'node:scene/*/action_line@edit'),
  ('导演', 'node:scene/*/music@edit'),
  ('导演', 'node:scene/*/stage_notes@edit'),
  ('导演', 'node:scene/*/synopsis@edit'),
  ('导演', 'node:script/*/rehearsal_marks@create'),
  ('导演', 'node:script/*/rehearsal_marks@delete'),
  ('导演', 'node:script/*/rehearsal_marks@edit'),
  ('导演', 'node:script/*/rehearsal_marks@view'),
  ('导演', 'node:script/*/rehearsal_marks/position@edit'),
  ('导演', 'node:task/*@view'),
  ('音乐导演', 'node:cue_list/*@create'),
  ('音乐导演', 'node:scene/*/music@edit'),
  ('音乐导演', 'node:script/*/rehearsal_marks@create'),
  ('音乐导演', 'node:script/*/rehearsal_marks@delete'),
  ('音乐导演', 'node:script/*/rehearsal_marks@edit'),
  ('音乐导演', 'node:script/*/rehearsal_marks@view'),
  ('音乐导演', 'node:script/*/rehearsal_marks/position@edit'),
  ('音乐导演', 'node:task/*@view'),
  ('作曲', 'node:cue_list/*@create'),
  ('作曲', 'node:scene/*/music@edit'),
  ('编曲', 'node:cue_list/*@create'),
  ('编曲', 'node:scene/*/music@edit'),
  ('音响设计', 'node:cue_list/*@create'),
  ('灯光设计', 'node:cue_list/*@create'),
  ('舞美设计', 'node:cue_list/*@create'),
  ('服化设计', 'node:cue_list/*@create'),
  ('多媒体设计', 'node:cue_list/*@create')
) AS k(role_name, permission_key) ON k.role_name = r.name
WHERE NOT r.is_deprecated
  -- 持通配全集的角色跳过：制作人的 node:*/*@* 已覆盖一切，补字面键纯噪音
  AND NOT EXISTS (
    SELECT 1 FROM production_role_permission w
    WHERE w.role_id = r.id AND w.permission_key = 'node:*/*@*'
  )
  AND (p.type IS NULL OR p.type IN ('stage_play', 'theatre', 'musical', 'dance'))
ON CONFLICT DO NOTHING;

COMMIT;
