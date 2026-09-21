-- migrate:up
-- #606：三张迁移回滚备份表退役。它们各自是 db/legacy/ 时代一次迁移的回滚依据
-- （migrate-node-tree.sql → wiki_alias_backup_node_tree / wiki_tree_backup_node_tree，
-- migrate-wiki-dialect-v2.sql → wiki_body_backup_dialect_v2），对应工程早已收官，
-- 没有代码读写。发布前 CD 自动 pg_dump，线上另留一份 pg_dump -t 到 shared/backups/。
DROP TABLE IF EXISTS wiki_alias_backup_node_tree;
DROP TABLE IF EXISTS wiki_tree_backup_node_tree;
DROP TABLE IF EXISTS wiki_body_backup_dialect_v2;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'irreversible'; END $$;
