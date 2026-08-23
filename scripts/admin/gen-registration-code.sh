#!/usr/bin/env bash
# 生成注册邀请码（registration_code，测试期注册邀请制 REGISTRATION_INVITE_ONLY）。
# 自包含脚本：建议连同 gen-plan-code.sh 一起放到服务器
#   /var/www/production-manager/shared/bin/ 下，随时可用，不依赖仓库检出。
#
# 用法:
#   ./gen-registration-code.sh                      # 一次性码，永不过期
#   ./gen-registration-code.sh 10                   # 可用 10 次
#   ./gen-registration-code.sh 10 30 "首批测试者"    # 可用 10 次，30 天过期，带备注
#
# 环境:
#   PGDATABASE  目标库（默认 script_editor）
#   PSQL        psql 调用方式（默认 sudo -u postgres psql；本地开发可设 PSQL=psql）
set -euo pipefail

DB="${PGDATABASE:-script_editor}"
PSQL_CMD="${PSQL:-sudo -u postgres psql}"

MAX_USES="${1:-1}"
DAYS="${2:-}"
NOTE="${3:-}"

[[ "$MAX_USES" =~ ^[0-9]+$ ]] || { echo "max_uses 必须是正整数" >&2; exit 1; }
[[ -z "$DAYS" || "$DAYS" =~ ^[0-9]+$ ]] || { echo "expires_days 必须是正整数或留空" >&2; exit 1; }

CODE="REG-$(openssl rand -hex 4 | tr 'a-f' 'A-F')"
EXPIRES_SQL="NULL"
[[ -n "$DAYS" ]] && EXPIRES_SQL="now() + interval '${DAYS} days'"
EXP_TEXT="永不"
[[ -n "$DAYS" ]] && EXP_TEXT="${DAYS} 天后"

$PSQL_CMD -d "$DB" -v ON_ERROR_STOP=1 \
  -v code="$CODE" -v max_uses="$MAX_USES" -v note="$NOTE" <<SQL
INSERT INTO registration_code (code, max_uses, expires_at, note)
VALUES (:'code', :'max_uses'::int, ${EXPIRES_SQL}, NULLIF(:'note', ''));
SQL

echo ""
echo "注册邀请码: ${CODE}"
echo "  可用次数: ${MAX_USES}   过期: ${EXP_TEXT}   备注: ${NOTE:-（无）}"
