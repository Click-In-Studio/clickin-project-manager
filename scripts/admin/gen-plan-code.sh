#!/usr/bin/env bash
# 生成等级兑换码（plan_code，#280 等级体系）。
# 自包含脚本：建议连同 gen-registration-code.sh 一起放到服务器
#   /var/www/production-manager/shared/bin/ 下，随时可用，不依赖仓库检出。
#
# 用法:
#   ./gen-plan-code.sh user creator                       # 用户升 creator，一次性
#   ./gen-plan-code.sh user internal 1 30 "新内部成员"     # 升 internal，30 天过期
#   ./gen-plan-code.sh production pro                     # 项目升 pro，一次性
#   ./gen-plan-code.sh production pro 1 "" "xx剧团" --exempt "特邀剧团"
#                                                         # 升 pro + 计费豁免（特邀项目）
#
# 参数: <kind: user|production> <tier> [max_uses=1] [expires_days] [note] [--exempt [豁免备注]]
#
# 环境:
#   PGDATABASE  目标库（默认 script_editor）
#   PSQL        psql 调用方式（默认 sudo -u postgres psql；本地开发可设 PSQL=psql）
set -euo pipefail

DB="${PGDATABASE:-script_editor}"
PSQL_CMD="${PSQL:-sudo -u postgres psql}"

KIND_ARG="${1:-}"
TIER="${2:-}"
MAX_USES="${3:-1}"
DAYS="${4:-}"
NOTE="${5:-}"
EXEMPT="false"
EXEMPT_NOTE=""
if [[ "${6:-}" == "--exempt" ]]; then
  EXEMPT="true"
  EXEMPT_NOTE="${7:-}"
fi

case "$KIND_ARG" in
  user)       KIND="user_upgrade"; PREFIX="PLAN-U" ;;
  production) KIND="production_upgrade"; PREFIX="PLAN-P" ;;
  *) echo "用法: $0 <user|production> <tier> [max_uses] [expires_days] [note] [--exempt [豁免备注]]" >&2; exit 1 ;;
esac
[[ -n "$TIER" ]] || { echo "缺少 tier（user: creator/internal；production: pro）" >&2; exit 1; }
[[ "$MAX_USES" =~ ^[0-9]+$ ]] || { echo "max_uses 必须是正整数" >&2; exit 1; }
[[ -z "$DAYS" || "$DAYS" =~ ^[0-9]+$ ]] || { echo "expires_days 必须是正整数或留空" >&2; exit 1; }
if [[ "$EXEMPT" == "true" && "$KIND" != "production_upgrade" ]]; then
  echo "--exempt 仅适用于 production 码（计费豁免是项目级属性）" >&2; exit 1
fi

CODE="${PREFIX}-$(openssl rand -hex 5 | tr 'a-f' 'A-F')"
EXPIRES_SQL="NULL"
[[ -n "$DAYS" ]] && EXPIRES_SQL="now() + interval '${DAYS} days'"
EXP_TEXT="永不"
[[ -n "$DAYS" ]] && EXP_TEXT="${DAYS} 天后"

$PSQL_CMD -d "$DB" -v ON_ERROR_STOP=1 \
  -v code="$CODE" -v kind="$KIND" -v tier="$TIER" -v max_uses="$MAX_USES" \
  -v exempt="$EXEMPT" -v exempt_note="$EXEMPT_NOTE" -v note="$NOTE" <<SQL
INSERT INTO plan_code (code, kind, grants_tier, grants_exempt, exempt_note, max_uses, expires_at, note)
VALUES (:'code', :'kind', :'tier', :'exempt'::boolean, NULLIF(:'exempt_note', ''),
        :'max_uses'::int, ${EXPIRES_SQL}, NULLIF(:'note', ''));
SQL

echo ""
echo "等级兑换码: ${CODE}"
echo "  类型: ${KIND}   档位: ${TIER}   豁免: ${EXEMPT}${EXEMPT_NOTE:+（${EXEMPT_NOTE}）}"
echo "  可用次数: ${MAX_USES}   过期: ${EXP_TEXT}   备注: ${NOTE:-（无）}"
