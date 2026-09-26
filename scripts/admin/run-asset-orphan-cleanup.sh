#!/usr/bin/env bash
# #427 受控清洗：以 postgres 用户执行，目录中须预置已审阅的迁移、快照、补偿 SQL 和本脚本。
# bash 本文件 prepare|rehearse|apply|restore <备份目录> <预期release路径> <预期条数>
set -euo pipefail
umask 077
mode=${1:?缺少操作}
stage=${2:?缺少备份目录}
expected_release=${3:?缺少部署版本}
expected_count=${4:?缺少已核对的候选数量}
case "$stage" in /var/www/production-manager/shared/backups/asset-permission-cleanup-*) ;; *) exit 2 ;; esac
[[ "$expected_count" =~ ^[0-9]+$ ]] || exit 2
[[ $(id -un) == postgres ]] || { echo '必须以 postgres 用户执行'; exit 2; }
actual_release=$(readlink -f /var/www/production-manager/current)
[[ "$actual_release" == "$expected_release" ]] || { echo '部署版本发生变化，中止'; exit 2; }
dbmate="$actual_release/bin/dbmate"
psql_args=(-X -qAt -v ON_ERROR_STOP=1 -d script_editor)
cd "$stage"

case "$mode" in
  prepare)
    [[ ! -e before.json && ! -e pre-cleanup.pgdump ]] || { echo '备份已存在，不覆盖'; exit 2; }
    pg_dump -Fc -f pre-cleanup.pgdump script_editor
    pg_restore --list pre-cleanup.pgdump > backup-contents.txt
    psql "${psql_args[@]}" --single-transaction -f snapshot.sql > before.json
    python3 - "$expected_count" <<'PY'
import json,sys
m=json.load(open('before.json'))
assert m['count']==int(sys.argv[1]), '候选数量变化，中止'
assert m['migration']=='20260926041043'
print('已备份，待撤销授权数：',m['count'])
PY
    sha256sum migrations/*.sql snapshot.sql restore.sql run.sh > reviewed-files.sha256
    ;;
  rehearse)
    sha256sum --check reviewed-files.sha256 > rehearsal-checksum-check.txt
    sed '/-- migrate:down/,$d' migrations/*.sql > rehearsal-up.sql
    psql "${psql_args[@]}" -v snapshot="$(cat before.json)" <<'SQL' > rehearsal.log
BEGIN;
SET LOCAL TIME ZONE 'UTC';
SELECT set_config('clickin.asset_cleanup_digest', :'snapshot'::jsonb->>'digest', true);
\i rehearsal-up.sql
\i restore.sql
DO $$
DECLARE backup jsonb := current_setting('clickin.asset_cleanup_snapshot')::jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(backup->'targets') s
    LEFT JOIN production_member_grant g ON g.id=(s->>'id')::uuid
    WHERE to_jsonb(g) IS DISTINCT FROM s
  ) THEN RAISE EXCEPTION 'rehearsal restore mismatch'; END IF;
END $$;
ROLLBACK;
SQL
    echo '清洗与补偿演练通过，整笔事务已回滚'
    ;;
  apply)
    sha256sum --check reviewed-files.sha256 > checksum-check.txt
    [[ -s pre-cleanup.pgdump ]] || exit 2
    digest=$(python3 -c "import json; print(json.load(open('before.json'))['digest'])")
    count=$(python3 -c "import json; print(json.load(open('before.json'))['count'])")
    [[ "$count" == "$expected_count" ]] || exit 2
    applied=$(psql "${psql_args[@]}" -c "SELECT count(*) FROM schema_migrations WHERE version='20260926041043'")
    [[ "$applied" == 0 ]] || { echo '迁移已执行，不重复写入'; exit 2; }
    # 摘要由数据库在同一事务持锁复核；工具自己负责 schema_migrations 记账。
    PGOPTIONS="-c clickin.asset_cleanup_digest=$digest" "$dbmate" \
      --url 'postgres:///script_editor?host=/var/run/postgresql&sslmode=disable' \
      --migrations-dir "$stage/migrations" --no-dump-schema up > migration.log 2>&1
    excluded=$(python3 -c "import json; print(json.dumps([r['id'] for r in json.load(open('before.json'))['targets']],separators=(',',':')))")
    PGOPTIONS="-c clickin.asset_cleanup_excluded_ids=$excluded" \
      psql "${psql_args[@]}" --single-transaction -f snapshot.sql > after.json
    # 精确比较每条目标行，除了撤销状态和原因之外不允许改变任何字段。
    psql "${psql_args[@]}" -v snapshot="$(cat before.json)" --single-transaction <<'SQL' > verified-count.txt
SET LOCAL TIME ZONE 'UTC';
SELECT count(*) FROM jsonb_array_elements(:'snapshot'::jsonb->'targets') s
JOIN production_member_grant g ON g.id=(s->>'id')::uuid
WHERE to_jsonb(g)=(s || '{"is_revoked":true,"revoked_reason":"manual"}'::jsonb);
SQL
    python3 - "$expected_count" <<'PY'
import json,sys
before=json.load(open('before.json')); after=json.load(open('after.json'))
assert after['count']==0, '仍有待清洗候选，停止后续环境执行'
assert before['unchanged_digest']==after['unchanged_digest'], '非目标数据发生变化，需核查'
assert int(open('verified-count.txt').read().strip())==int(sys.argv[1]), '目标行验证失败'
print('清洗成功；只修改撤销状态与原因，目标授权数：',before['count'])
PY
    psql "${psql_args[@]}" -c "SELECT version FROM schema_migrations WHERE version='20260926041043'" > applied-version.txt
    [[ $(cat applied-version.txt) == 20260926041043 ]] || exit 2
    date -u +%Y-%m-%dT%H:%M:%SZ > completed-at.txt
    ;;
  restore)
    sha256sum --check reviewed-files.sha256 > restore-checksum-check.txt
    psql "${psql_args[@]}" --single-transaction -v snapshot="$(cat before.json)" -f restore.sql > restore.log
    psql "${psql_args[@]}" --single-transaction -f snapshot.sql > restored.json
    python3 - <<'PY'
import json
before=json.load(open('before.json')); after=json.load(open('restored.json'))
assert before['digest']==after['digest'], '补偿后候选不等于原始快照'
assert before['unchanged_digest']==after['unchanged_digest'], '非目标数据发生变化，需核查'
print('已按快照定向补偿；迁移执行历史仍保留，不重复执行同一版本')
PY
    ;;
  *) echo '仅支持 prepare/rehearse/apply/restore'; exit 2 ;;
esac
