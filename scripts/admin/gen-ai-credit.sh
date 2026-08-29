#!/usr/bin/env bash
# AI 额外额度（#383）：发码或直接发放。
# 自包含脚本：与 gen-plan-code.sh 一起放到服务器
#   /var/www/production-manager/shared/bin/ 下，随时可用，不依赖仓库检出。
#
# 两种发放方式，都没有界面（与 plan_code 同规约：管理员手工执行）：
#   code  → 生成一张 AI 额度码，用户在个人中心自己兑换（「想多用就买」的载体：
#           线下收钱 → 发码；兑换次数/过期/暴破限流全是 plan_code 现成的）
#   grant → 直接落到某个用户头上（补偿、内测、事故补偿这类不走钱的场景）
#
# 用法:
#   ./gen-ai-credit.sh code 5000000                          # 500 万 credit，一次性
#   ./gen-ai-credit.sh code 5000000 3 90 "10月团购"           # 可用 3 次、90 天过期
#   ./gen-ai-credit.sh grant <user_uuid> 1000000 "事故补偿"    # 直接发放
#
# 额度换算：一次问答 ≈ 1.2 万 credit（线上实测），所以 5M ≈ 400 次问答。
# 单价与档位额度见 lib/plan.ts——改那里的单价会改变这些数字的实际购买力。
#
# 环境:
#   PGDATABASE  目标库（默认 script_editor）
#   PSQL        psql 调用方式（默认 sudo -u postgres psql；本地开发可设 PSQL=psql）
set -euo pipefail

DB="${PGDATABASE:-script_editor}"
PSQL_CMD="${PSQL:-sudo -u postgres psql}"

MODE="${1:-}"

new_id() { echo "acg_$(date +%s | xargs printf '%x')$(openssl rand -hex 4)"; }

case "$MODE" in
  code)
    CREDITS="${2:-}"
    MAX_USES="${3:-1}"
    DAYS="${4:-}"
    NOTE="${5:-}"
    [[ "$CREDITS" =~ ^[0-9]+$ && "$CREDITS" -gt 0 ]] || { echo "credits 必须是正整数" >&2; exit 1; }
    [[ "$MAX_USES" =~ ^[0-9]+$ ]] || { echo "max_uses 必须是正整数" >&2; exit 1; }
    [[ -z "$DAYS" || "$DAYS" =~ ^[0-9]+$ ]] || { echo "expires_days 必须是正整数或留空" >&2; exit 1; }

    CODE="PLAN-C-$(openssl rand -hex 5 | tr 'a-f' 'A-F')"
    EXPIRES_SQL="NULL"
    [[ -n "$DAYS" ]] && EXPIRES_SQL="now() + interval '${DAYS} days'"

    # grants_tier 必须为 NULL（plan_code_grants_check）：额度码不授档位。
    $PSQL_CMD -d "$DB" -v ON_ERROR_STOP=1 \
      -v code="$CODE" -v credits="$CREDITS" -v max_uses="$MAX_USES" -v note="$NOTE" <<SQL
INSERT INTO plan_code (code, kind, grants_tier, grants_credits, max_uses, expires_at, note)
VALUES (:'code', 'ai_credits', NULL, :'credits'::bigint, :'max_uses'::int, ${EXPIRES_SQL}, NULLIF(:'note', ''));
SQL
    echo ""
    echo "AI 额度码: ${CODE}"
    echo "  额度: ${CREDITS} credit（≈ $((CREDITS / 12000)) 次问答）"
    echo "  可用次数: ${MAX_USES}   过期: ${DAYS:-永不}${DAYS:+ 天后}   备注: ${NOTE:-（无）}"
    ;;

  grant)
    USER_ID="${2:-}"
    CREDITS="${3:-}"
    NOTE="${4:-}"
    DAYS="${5:-}"
    [[ -n "$USER_ID" ]] || { echo "缺少 user_id（app_user.id，UUID）" >&2; exit 1; }
    [[ "$CREDITS" =~ ^[0-9]+$ && "$CREDITS" -gt 0 ]] || { echo "credits 必须是正整数" >&2; exit 1; }
    [[ -z "$DAYS" || "$DAYS" =~ ^[0-9]+$ ]] || { echo "expires_days 必须是正整数或留空" >&2; exit 1; }

    EXPIRES_SQL="NULL"
    [[ -n "$DAYS" ]] && EXPIRES_SQL="now() + interval '${DAYS} days'"
    ID="$(new_id)"

    $PSQL_CMD -d "$DB" -v ON_ERROR_STOP=1 \
      -v id="$ID" -v uid="$USER_ID" -v credits="$CREDITS" -v note="$NOTE" <<SQL
INSERT INTO ai_credit_grant (id, user_id, credits, remaining, source, note, expires_at)
VALUES (:'id', :'uid'::uuid, :'credits'::bigint, :'credits'::bigint, 'admin', NULLIF(:'note', ''), ${EXPIRES_SQL});
SQL
    echo ""
    echo "已发放 AI 额度: ${CREDITS} credit（≈ $((CREDITS / 12000)) 次问答）→ ${USER_ID}"
    echo "  记录 id: ${ID}   过期: ${DAYS:-永不}${DAYS:+ 天后}   备注: ${NOTE:-（无）}"
    ;;

  *)
    echo "用法:" >&2
    echo "  $0 code  <credits> [max_uses=1] [expires_days] [note]" >&2
    echo "  $0 grant <user_uuid> <credits> [note] [expires_days]" >&2
    exit 1
    ;;
esac
