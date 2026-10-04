#!/usr/bin/env bash
# End-to-end check of the zero-config stack, including the F2 security gate.
# Usage: docker/smoke-test.sh            (builds, starts a throwaway stack, tears it down)
#        KEEP=1 docker/smoke-test.sh     (leave the stack running afterwards)
set -euo pipefail

PROJECT=bokydo-smoke
PORT=${PORT:-18080}
C=(docker compose -p "$PROJECT" -f compose.yml -f docker/compose.smoke.yml)
BASE="http://127.0.0.1:$PORT"
MAILPIT="http://127.0.0.1:${MAILPIT_PORT:-18025}"
JAR=$(mktemp)
fail=0

cd "$(dirname "$0")/.."
cleanup() {
  rm -f "$JAR"
  [[ "${KEEP:-}" == 1 ]] || "${C[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

check() { # check <description> <command...>
  local desc=$1; shift
  if "$@" >/dev/null 2>&1; then echo "  ok   $desc"; else echo "  FAIL $desc"; fail=1; fi
}
http_code() { curl -s -o /dev/null -w '%{http_code}' --path-as-is "$@"; }
app_exec() { "${C[@]}" exec -T app "$@"; }
# Browser-like API call: cookie jar, same-origin Origin header, CSRF token once we have one.
CSRF=""
api() { # api <METHOD> <path> [json-body]
  local args=(-s -b "$JAR" -c "$JAR" -X "$1" -H "Origin: $BASE")
  [[ -n "$CSRF" ]] && args+=(-H "x-csrf-token: $CSRF")
  [[ $# -ge 3 ]] && args+=(-H 'content-type: application/json' --data "$3")
  curl "${args[@]}" -w '\n%{http_code}' "$BASE$2"
}
status_of() { tail -n1 <<<"$1"; }
body_of() { sed '$d' <<<"$1"; }
volume() { docker run --rm -v "${PROJECT}_$1:/v:ro" busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e "${@:2}"; }

echo "== starting stack"
PORT=$PORT "${C[@]}" up -d --build --quiet-pull >/dev/null 2>&1 || { "${C[@]}" logs --tail 50; exit 1; }
for _ in $(seq 60); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "${PROJECT}-app-1" 2>/dev/null)" == healthy ]] && break
  sleep 2
done

echo "== first boot"
check "app is healthy"                 test "$(docker inspect -f '{{.State.Health.Status}}' "${PROJECT}-app-1")" = healthy
check "readyz reports DB reachable"    test "$(http_code "$BASE/readyz")" = 200
check "instance status: setup pending" bash -c "curl -s $BASE/api/v1/instance | grep -q '\"setupComplete\":false'"
check "admin passphrase banner printed once" \
  test "$("${C[@]}" logs app | grep -c 'Passphrase: [a-z-]\{20,\}')" = 1

echo "== container hardening"
check "app runs as non-root"           test "$(docker inspect -f '{{.Config.User}}' "${PROJECT}-app-1")" = nonroot
check "app root filesystem read-only"  test "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "${PROJECT}-app-1")" = true
check "app cannot write to /app" \
  bash -c "! ${C[*]} exec -T app /nodejs/bin/node -e 'require(\"fs\").writeFileSync(\"/app/x\",\"1\")'"
check "database port not published"   test -z "$(docker port "${PROJECT}-db-1")"
check "database has no internet egress" \
  docker exec "${PROJECT}-db-1" bash -c '! timeout 3 bash -c "</dev/tcp/1.1.1.1/443"'
check "no secrets in app environment" \
  bash -c "! docker inspect -f '{{json .Config.Env}}' ${PROJECT}-app-1 | grep -qi password"

echo "== secrets on disk"
check "app secrets dir is 0700 uid 65532" \
  test "$(volume app-data stat -c '%a %u' /v/secrets)" = "700 65532"
for f in db_password master.key session.key; do
  check "app $f is 0400 uid 65532" test "$(volume app-data stat -c '%a %u' "/v/secrets/$f")" = "400 65532"
done
check "postgres password is 0400 uid 999" test "$(volume pg-secret stat -c '%a %u' /v/password)" = "400 999"
check "postgres cannot see app master key" \
  docker exec "${PROJECT}-db-1" bash -c '[[ ! -e /data && ! -e /run/bokydo-pg/master.key && $(ls /run/bokydo-pg) == password ]]'

echo "== HTTP surface"
check "CSP has no unsafe-inline" \
  bash -c "curl -sI $BASE/ | grep -i '^content-security-policy' | grep -vq unsafe-inline"
check "API responses are no-store"    bash -c "curl -sI $BASE/api/v1/instance | grep -qi '^cache-control: no-store'"
check "X-Frame-Options DENY"           bash -c "curl -sI $BASE/ | grep -qi '^x-frame-options: DENY'"
check "no CORS for foreign origins" \
  bash -c "! curl -s -D - -o /dev/null -H 'Origin: https://evil.example' $BASE/api/v1/instance | grep -qi access-control-allow-origin"
for path in '/../../etc/passwd' '/assets/..%2f..%2f..%2fetc%2fpasswd' '/.env' '/package.json' '/../dist/main.js'; do
  check "no file served for $path" test "$(http_code "$BASE$path")" = 404
done
check "oversized body rejected (413)" \
  test "$(head -c 1100000 /dev/zero | tr '\0' a | http_code -X POST -H 'content-type: application/json' --data-binary @- "$BASE/api/v1/instance")" = 413

echo "== first-run setup flow"
PASSPHRASE=$("${C[@]}" logs app | grep -o 'Passphrase: [a-z-]*' | head -1 | cut -d' ' -f2)
NEWPW='quartz-lantern-gravel-ribbon-smoke'
check "foreign Origin cannot log in" \
  test "$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example' -H 'content-type: application/json' \
    --data "{\"username\":\"admin\",\"password\":\"$PASSPHRASE\"}" "$BASE/api/v1/auth/login")" = 403
r=$(api POST /api/v1/auth/login "{\"username\":\"admin\",\"password\":\"$PASSPHRASE\"}")
check "admin signs in with the one-time passphrase" test "$(status_of "$r")" = 200
CSRF=$(body_of "$r" | jq -r .csrfToken)
check "session cookie is HttpOnly" grep -q '#HttpOnly_127.0.0.1' "$JAR"
check "setup blocked until password changed" \
  bash -c "[[ \"$(body_of "$(api GET /api/v1/setup)" | jq -r .error)\" == password_change_required ]]"
r=$(api POST /api/v1/auth/password "{\"currentPassword\":\"$PASSPHRASE\",\"newPassword\":\"$NEWPW\"}")
check "password changed" test "$(status_of "$r")" = 200
CSRF=$(body_of "$r" | jq -r .csrfToken)
r=$(api PUT /api/v1/setup/public-url "{\"publicUrl\":\"$BASE\"}")
check "public URL set" test "$(body_of "$r" | jq -r .canComplete)" = true
r=$(api PATCH /api/v1/admin/settings '{"email.smtpHost":"mailpit","email.smtpPort":1025,"email.smtpSecurity":"none","email.smtpUsername":"bokydo","email.smtpPassword":"smoke-smtp-secret","email.fromAddress":"bokydo@example.com"}')
check "SMTP settings saved" test "$(status_of "$r")" = 200
check "SMTP password is write-only" bash -c "! grep -q smoke-smtp-secret <<<'$(body_of "$r")'"
check "SMTP password encrypted at rest" \
  bash -c "! docker exec ${PROJECT}-db-1 psql -U bokydo -d bokydo -Atc \"select value::text from instance_settings\" | grep -q smoke-smtp-secret"
r=$(api POST /api/v1/admin/email/test '{"to":"owner@example.com"}')
check "test email accepted" test "$(status_of "$r")" = 200
check "test email delivered" bash -c "curl -s $MAILPIT/api/v1/messages | jq -e '.messages[0].Subject | test(\"test email\")'"
check "API refuses foreign Origin with a valid session" \
  test "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST -H 'Origin: https://evil.example' -H "x-csrf-token: $CSRF" "$BASE/api/v1/setup/complete")" = 403
check "API refuses missing CSRF token" \
  test "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST -H "Origin: $BASE" "$BASE/api/v1/setup/complete")" = 403
r=$(api POST /api/v1/setup/complete)
check "setup completes" test "$(status_of "$r")" = 204
check "instance reports setup complete" bash -c "curl -s $BASE/api/v1/instance | jq -e .setupComplete"
check "setup wizard gone afterwards" test "$(status_of "$(api GET /api/v1/setup)")" = 404

echo "== restarts & recovery"
"${C[@]}" restart app >/dev/null 2>&1
sleep 5
check "restart creates no second admin" \
  test "$(docker exec "${PROJECT}-db-1" psql -U bokydo -d bokydo -Atc 'select count(*) from users')" = 1
check "bootstrap re-run keeps secrets" bash -c "${C[*]} run --rm bootstrap"
check "CLI reset-password works" bash -c "${C[*]} exec -T app bokydo admin reset-password admin | grep -q 'Passphrase: [a-z]'"
check "CLI reset-password rejects unknown user" bash -c "! ${C[*]} exec -T app bokydo admin reset-password nobody"
check "CLI clear-public-url works" bash -c "${C[*]} exec -T app bokydo admin clear-public-url | grep -q cleared"
check "reset revokes existing sessions" test "$(status_of "$(api GET /api/v1/auth/session)")" = 401
check "reset is audited" \
  test "$(docker exec "${PROJECT}-db-1" psql -U bokydo -d bokydo -Atc "select count(*) from audit_log where action='user.password_reset_cli'")" = 1

if [[ $fail == 0 ]]; then echo "== all checks passed"; else echo "== FAILURES"; "${C[@]}" logs --tail 50; fi
exit $fail
