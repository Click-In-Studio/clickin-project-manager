-- 线上对账（#561，一次性）：把 script_editor 库对齐到 db/schema.sql 的形状，
-- 然后在 schema_migrations 里记下 baseline。之后 CD 每次发布核对线上指纹 ==
-- db/schema-fingerprint.txt，这一类「删了没删掉 / 记了没执行」不再静默存在。
--
-- 执行方式（人工，一次）：
--   1. 备份：sudo -u postgres pg_dump -d script_editor --format=custom --compress=9 \
--             > /var/www/production-manager/shared/backups/pre_reconcile_$(date +%Y%m%d_%H%M%S).pgdump
--   2. 执行：sudo -u postgres psql -v ON_ERROR_STOP=1 -d script_editor -f reconcile-prod-2026-09.sql
--   3. 核对：sudo -u postgres psql -d script_editor -qAt -f fingerprint.sql | diff schema-fingerprint.txt -
--      （两个文件从仓库同一 commit 拷到服务器；diff 无输出即对齐）
--
-- 每一项的证据见 #561 正文。整段一个事务，任一步失败即整体回滚。

BEGIN;

-- ── A. 记账说执行了、库里没有的（#556 同类） ──────────────────────────────────

-- migrate-cue-list-role.sql 记在 db-applied.txt 但从未执行：它要删的列还在（0 行有值，
-- 代码零引用）；它要建的 cue_list_role 表后来已被 migrate-cue-list-to-resource-grant
-- 退役，不必补建。
ALTER TABLE cue_list DROP COLUMN IF EXISTS default_edit_roles;

-- fix-block-tag-logical-id.sql 在 9d3dc22 被删（message 称已执行），FK 仍在（#560）。
-- block_tag.block_id 存逻辑 block_id，不是 script.id；schema.sql 明确无 FK。
ALTER TABLE block_tag DROP CONSTRAINT IF EXISTS block_tag_block_id_fkey;

-- ── B. schema.sql 有、线上没有 ────────────────────────────────────────────────

-- event_call_time.rsvp 的 CHECK（线上现有 26 行全 NULL，不违反）
ALTER TABLE event_call_time DROP CONSTRAINT IF EXISTS event_call_time_rsvp_check;
ALTER TABLE event_call_time ADD CONSTRAINT event_call_time_rsvp_check
  CHECK (rsvp IN ('yes', 'no', 'tentative'));

-- cue_list.abbr 唯一性：线上是 UNIQUE 约束，schema.sql 是 UNIQUE 索引（语义相同，
-- 指纹不同）。改成索引对齐 schema.sql；同一事务内不存在无唯一性的瞬间。
ALTER TABLE cue_list DROP CONSTRAINT IF EXISTS cue_list_abbr_production_unique;
CREATE UNIQUE INDEX IF NOT EXISTS cue_list_abbr_production_unique ON cue_list(production_id, abbr);

-- ── C. 线上有、schema.sql 没有：备份表上的多余对象 ───────────────────────────
-- wiki_alias_backup_node_tree 是 migrate-node-tree 的回滚备份（#420 收口时单独
-- DROP）。schema.sql 只保留裸表，线上多出的 FK / 唯一约束 / 三个索引去掉。
ALTER TABLE wiki_alias_backup_node_tree DROP CONSTRAINT IF EXISTS wiki_alias_parent_id_fkey;
ALTER TABLE wiki_alias_backup_node_tree DROP CONSTRAINT IF EXISTS wiki_alias_place_target_uniq;
DROP INDEX IF EXISTS wiki_alias_place_target_uniq;
DROP INDEX IF EXISTS wiki_alias_parent_idx;
DROP INDEX IF EXISTS wiki_alias_production_idx;
DROP INDEX IF EXISTS wiki_alias_target_idx;

-- ── D. 约束名对齐 schema.sql（定义完全相同，只是名字不同） ─────────────────
-- 线上名字来自早期手写 migration（*_user_fk）与后来改过名的表（resource_grant →
-- production_member_grant、production_wiki_config → production_node_config、
-- wiki_alias → 备份表）。不对齐的话，将来任何按 schema.sql 写的 DROP CONSTRAINT 上线必炸。
ALTER TABLE asset                       RENAME CONSTRAINT asset_uploader_user_fk                   TO asset_uploader_user_id_fkey;
ALTER TABLE comment                     RENAME CONSTRAINT comment_user_fk                          TO comment_user_id_fkey;
ALTER TABLE cue_list                    RENAME CONSTRAINT cue_list_created_by_fk                   TO cue_list_created_by_fkey;
ALTER TABLE event_call_time             RENAME CONSTRAINT event_call_time_user_fk                  TO event_call_time_user_id_fkey;
ALTER TABLE event_participant           RENAME CONSTRAINT event_participant_event_user_unique      TO event_participant_event_id_user_id_key;
ALTER TABLE event_participant           RENAME CONSTRAINT event_participant_user_fk                TO event_participant_user_id_fkey;
ALTER TABLE event_report_read           RENAME CONSTRAINT event_report_read_user_fk                TO event_report_read_user_id_fkey;
ALTER TABLE event_stage_manager         RENAME CONSTRAINT event_stage_manager_user_fk              TO event_stage_manager_user_id_fkey;
ALTER TABLE node_mount                  RENAME CONSTRAINT asset_mount_created_by_fk                TO node_mount_created_by_fkey;
ALTER TABLE notification_subscription   RENAME CONSTRAINT notification_subscription_user_fk        TO notification_subscription_user_id_fkey;
ALTER TABLE production_event            RENAME CONSTRAINT production_event_created_by_fk           TO production_event_created_by_fkey;
ALTER TABLE production_member           RENAME CONSTRAINT production_member_user_fk                TO production_member_user_id_fkey;
ALTER TABLE production_member_grant     RENAME CONSTRAINT resource_grant_approval_fk               TO production_member_grant_approval_id_fkey;
ALTER TABLE production_member_grant     RENAME CONSTRAINT resource_grant_confirmed_by_fkey         TO production_member_grant_confirmed_by_fkey;
ALTER TABLE production_member_grant     RENAME CONSTRAINT resource_grant_grant_source_check        TO production_member_grant_grant_source_check;
ALTER TABLE production_member_grant     RENAME CONSTRAINT resource_grant_pkey                      TO production_member_grant_pkey;
ALTER TABLE production_member_grant     RENAME CONSTRAINT resource_grant_production_id_fkey        TO production_member_grant_production_id_fkey;
ALTER TABLE production_member_grant     RENAME CONSTRAINT resource_grant_revoked_reason_check      TO production_member_grant_revoked_reason_check;
ALTER TABLE production_member_grant     RENAME CONSTRAINT resource_grant_user_id_fkey              TO production_member_grant_user_id_fkey;
ALTER TABLE production_member_permission RENAME CONSTRAINT production_member_permission_user_fk    TO production_member_permission_user_id_fkey;
ALTER TABLE production_node_config      RENAME CONSTRAINT production_wiki_config_pkey              TO production_node_config_pkey;
ALTER TABLE production_node_config      RENAME CONSTRAINT production_wiki_config_production_id_fkey TO production_node_config_production_id_fkey;
ALTER TABLE schedule_item_participant   RENAME CONSTRAINT schedule_item_participant_user_fk        TO schedule_item_participant_user_id_fkey;
ALTER TABLE wiki_alias_backup_node_tree RENAME CONSTRAINT wiki_alias_created_by_fkey               TO wiki_alias_backup_node_tree_created_by_fkey;
ALTER TABLE wiki_alias_backup_node_tree RENAME CONSTRAINT wiki_alias_pkey                          TO wiki_alias_backup_node_tree_pkey;
ALTER TABLE wiki_alias_backup_node_tree RENAME CONSTRAINT wiki_alias_production_id_fkey            TO wiki_alias_backup_node_tree_production_id_fkey;
-- （PK / UNIQUE 约束改名时其底层索引随之改名，无需单独 ALTER INDEX）

-- ── E. 表 owner 归 postgres ───────────────────────────────────────────────────
-- 四张表是运行时 migration 时代由应用用户建的，owner 是 script_editor，等于给了
-- 应用用户 DDL 权。其余 126 张全是 postgres。
ALTER TABLE version                  OWNER TO postgres;
ALTER TABLE script_version           OWNER TO postgres;
ALTER TABLE cue_version              OWNER TO postgres;
ALTER TABLE schedule_item_department OWNER TO postgres;

-- ── F. dbmate 记账：baseline 视为已应用 ──────────────────────────────────────
-- 表结构与 dbmate 2.36 自建的完全一致（version varchar(128) PRIMARY KEY）。
CREATE TABLE IF NOT EXISTS public.schema_migrations (version VARCHAR(128) PRIMARY KEY);
INSERT INTO public.schema_migrations (version) VALUES ('20260919000000') ON CONFLICT DO NOTHING;

COMMIT;

-- 保留不动（登记在 #561 挂账）：
--   · agent_user 角色在 26 张表上的 DML 授权（OpenClaw 已退役，择机 REVOKE + DROP ROLE）
--   · wiki_alias_backup_node_tree / wiki_tree_backup_node_tree / wiki_body_backup_dialect_v2
--     三张备份表，随各自 issue 收口时 DROP（schema.sql 里同步删）
--   · shared/db-applied.txt：CD 不再读写，留作历史
