-- 角色模板对齐线上 + 清除退役键残留（2026-08-17）。
--
-- 背景：线上 grant_template 108 行里有 69 行在 db/ 里根本没有 seed——编剧 26 枚、
--   戏剧构作 13 枚、导演 10 枚、制作助理 7 枚…… 全是历次「线上清理」手工配进
--   生产库的，仓库从没记录。后果：**新建演出的创作组开箱即残**——新演出的编剧
--   连 node:script/*/blocks@edit 都没有，激活面修好了也没有区间可激活。
--
-- 本文件把线上既成事实固化为仓库 seed，让 db/ 重新成为模板的单一事实源。
-- 对生产库是幂等 no-op（这些行本就在），真正受益的是此后新建的演出与 CI 库。
--
-- 两处与线上的有意差异：
--   1. 不含 node:scene/*/meta@edit——错配键，已由 migrate-scene-field-gates.sql
--      清除（判定端查的是 meta/name）
--   2. 编剧 / 戏剧构作的四枚 scene 字段键由同一支迁移补，不在此文件重复
--
-- 为何是 migrate 而非 add：除了补行，还要清 grant_template 里的退役原子键
--   残留（存量数据语义，批D 教训「add 文件不能藏存量数据语义」）。
--
-- 幂等，可重复执行。

BEGIN;

-- ── 0. 退役原子键残留清理 ────────────────────────────────────────────────────
-- 批E-2 退役 script:comment 时清了三张区间表，却漏了 grant_template 这一处
-- （migrate-script-rest.sql 的 DELETE 只覆盖 role/member/dept permission）。
-- 生产库已是 0 行（历次线上清理时手工删过），但**任何从 schema.sql 建的库
-- 都会重新长出它**——CI 就是这么红的。
--
-- 终局形态下模板键全是节点串（node:type/id[/sub]@verb），故一网打尽而不是
-- 逐键列举：原子键机制已于批G G-2 整体退役。
DELETE FROM grant_template WHERE permission_key NOT LIKE 'node:%';

-- *（2 枚）
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('*', 'node:announcement/*@view'),
  ('*', 'node:milestone/*@view')
ON CONFLICT DO NOTHING;

-- 制作助理（7 枚）
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('制作助理', 'node:announcement/*@create'),
  ('制作助理', 'node:announcement/*@delete'),
  ('制作助理', 'node:announcement/*@edit'),
  ('制作助理', 'node:milestone/*@create'),
  ('制作助理', 'node:milestone/*@delete'),
  ('制作助理', 'node:milestone/*@edit'),
  ('制作助理', 'node:task/*@view')
ON CONFLICT DO NOTHING;

-- 编剧（26 枚）
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('编剧', 'node:character/*@create'),
  ('编剧', 'node:character/*@delete'),
  ('编剧', 'node:character/*@edit'),
  ('编剧', 'node:scene/*/action_line@edit'),
  ('编剧', 'node:scene/*/stage_notes@edit'),
  ('编剧', 'node:scene/*/synopsis@edit'),
  ('编剧', 'node:scene/*@create'),
  ('编剧', 'node:scene/*@delete'),
  ('编剧', 'node:script/*/blocks/character@edit'),
  ('编剧', 'node:script/*/blocks/position@edit'),
  ('编剧', 'node:script/*/blocks/tags@edit'),
  ('编剧', 'node:script/*/blocks/type@edit'),
  ('编剧', 'node:script/*/blocks@create'),
  ('编剧', 'node:script/*/blocks@delete'),
  ('编剧', 'node:script/*/blocks@edit'),
  ('编剧', 'node:script/*/mounts@create'),
  ('编剧', 'node:script/*/rehearsal_marks/position@edit'),
  ('编剧', 'node:script/*/rehearsal_marks@create'),
  ('编剧', 'node:script/*/rehearsal_marks@delete'),
  ('编剧', 'node:script/*/rehearsal_marks@edit'),
  ('编剧', 'node:script/*/rehearsal_marks@view'),
  ('编剧', 'node:tag_group/*/options@create'),
  ('编剧', 'node:tag_group/*/options@delete'),
  ('编剧', 'node:tag_group/*@create'),
  ('编剧', 'node:tag_group/*@delete'),
  ('编剧', 'node:tag_group/*@edit')
ON CONFLICT DO NOTHING;

-- 戏剧构作（13 枚）
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('戏剧构作', 'node:character/*@create'),
  ('戏剧构作', 'node:character/*@delete'),
  ('戏剧构作', 'node:character/*@edit'),
  ('戏剧构作', 'node:scene/*/action_line@edit'),
  ('戏剧构作', 'node:scene/*/stage_notes@edit'),
  ('戏剧构作', 'node:scene/*/synopsis@edit'),
  ('戏剧构作', 'node:scene/*@create'),
  ('戏剧构作', 'node:scene/*@delete'),
  ('戏剧构作', 'node:tag_group/*/options@create'),
  ('戏剧构作', 'node:tag_group/*/options@delete'),
  ('戏剧构作', 'node:tag_group/*@create'),
  ('戏剧构作', 'node:tag_group/*@delete'),
  ('戏剧构作', 'node:tag_group/*@edit')
ON CONFLICT DO NOTHING;

-- 导演（10 枚）
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('导演', 'node:event/*/publication@view'),
  ('导演', 'node:scene/*/action_line@edit'),
  ('导演', 'node:scene/*/music@edit'),
  ('导演', 'node:scene/*/stage_notes@edit'),
  ('导演', 'node:scene/*/synopsis@edit'),
  ('导演', 'node:script/*/rehearsal_marks/position@edit'),
  ('导演', 'node:script/*/rehearsal_marks@create'),
  ('导演', 'node:script/*/rehearsal_marks@delete'),
  ('导演', 'node:script/*/rehearsal_marks@edit'),
  ('导演', 'node:script/*/rehearsal_marks@view')
ON CONFLICT DO NOTHING;

-- 音乐导演（6 枚）
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('音乐导演', 'node:scene/*/music@edit'),
  ('音乐导演', 'node:script/*/rehearsal_marks/position@edit'),
  ('音乐导演', 'node:script/*/rehearsal_marks@create'),
  ('音乐导演', 'node:script/*/rehearsal_marks@delete'),
  ('音乐导演', 'node:script/*/rehearsal_marks@edit'),
  ('音乐导演', 'node:script/*/rehearsal_marks@view')
ON CONFLICT DO NOTHING;

-- 作曲（1 枚）
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('作曲', 'node:scene/*/music@edit')
ON CONFLICT DO NOTHING;

-- 编曲（1 枚）
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('编曲', 'node:scene/*/music@edit')
ON CONFLICT DO NOTHING;

-- 后台舞台监督（3 枚）
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('后台舞台监督', 'node:event/*/publication@create'),
  ('后台舞台监督', 'node:event/*/publication@delete'),
  ('后台舞台监督', 'node:event/*@view')
ON CONFLICT DO NOTHING;

COMMIT;
