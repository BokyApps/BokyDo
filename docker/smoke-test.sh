#!/usr/bin/env bash
# End-to-end check of the zero-config stack, including the F2 security gate.
# Usage: docker/smoke-test.sh            (builds, starts a throwaway stack, tears it down)
#        KEEP=1 docker/smoke-test.sh     (leave the stack running afterwards)
set -euo pipefail

PROJECT=${PROJECT:-bokydo-smoke}
PORT=${PORT:-18080}
C=(docker compose -p "$PROJECT" -f compose.yml -f docker/compose.smoke.yml)
BASE="http://127.0.0.1:$PORT"
MAILPIT="http://127.0.0.1:${MAILPIT_PORT:-18025}"
JAR=$(mktemp)
ADMIN_JAR=$JAR
SAM_JAR=$(mktemp)
fail=0

cd "$(dirname "$0")/.."
cleanup() {
  rm -f "$ADMIN_JAR" "$SAM_JAR"
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
volume_rw() { docker run --rm -v "${PROJECT}_$1:/v" busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e "${@:2}"; }

echo "== starting stack"
PORT=$PORT "${C[@]}" up -d --build --quiet-pull >/dev/null 2>&1 || { "${C[@]}" logs --tail 50; exit 1; }
for _ in $(seq 60); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "${PROJECT}-app-1" 2>/dev/null)" == healthy ]] && break
  sleep 2
done

echo "== first boot"
check "the stack is just app + postgres (no init container)" \
  test "$(docker compose -f compose.yml config --services | sort | tr '\n' ' ')" = "app db "
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
for f in db_password master.key session.key vapid.key; do
  check "app $f is 0400 uid 65532" test "$(volume app-data stat -c '%a %u' "/v/secrets/$f")" = "400 65532"
done
check "shared DB password is 0400 uid 65532" test "$(volume db-secret stat -c '%a %u' /v/password)" = "400 65532"
check "shared volume holds only the DB password" test "$(volume db-secret ls -A /v)" = password
check "postgres keeps its copy in memory, 0400 uid 999" \
  test "$(docker exec "${PROJECT}-db-1" stat -c '%a %u %m' /run/bokydo-pg/password)" = "400 999 /run/bokydo-pg"
check "postgres cannot see app master key" \
  docker exec "${PROJECT}-db-1" bash -c '[[ ! -e /data && ! -e /run/bokydo-db/master.key && $(ls /run/bokydo-db) == password ]]'
check "app and postgres copies match" \
  test "$(volume db-secret sha256sum /v/password | cut -d' ' -f1)" = "$(volume app-data sha256sum /v/secrets/db_password | cut -d' ' -f1)"
DB_PW_HASH=$(volume db-secret sha256sum /v/password | cut -d' ' -f1)

echo "== HTTP surface"
check "CSP has no unsafe-inline" \
  bash -c "curl -sI $BASE/ | grep -i '^content-security-policy' | grep -vq unsafe-inline"
check "API responses are no-store"    bash -c "curl -sI $BASE/api/v1/instance | grep -qi '^cache-control: no-store'"
check "X-Frame-Options DENY"           bash -c "curl -sI $BASE/ | grep -qi '^x-frame-options: DENY'"
check "cross-origin isolated (COEP/COOP/CORP)" \
  bash -c "curl -sI $BASE/ | grep -qi '^cross-origin-embedder-policy: require-corp' \
    && curl -sI $BASE/ | grep -qi '^cross-origin-opener-policy: same-origin' \
    && curl -sI $BASE/ | grep -qi '^cross-origin-resource-policy: same-origin'"
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

echo "== sync engine"
TASK_ID=$(cat /proc/sys/kernel/random/uuid)
CMD_ID=$(cat /proc/sys/kernel/random/uuid)
r=$(api POST /api/v1/sync "{\"cursor\":null,\"commands\":[{\"type\":\"task_add\",\"uuid\":\"$CMD_ID\",\"args\":{\"id\":\"$TASK_ID\",\"content\":\"Smoke task\"}}]}")
check "full sync returns an inbox" bash -c "jq -e '.projects[] | select(.isInbox)' <<<'$(body_of "$r")'"
check "task_add applied" bash -c "jq -e '.results[\"$CMD_ID\"].ok' <<<'$(body_of "$r")'"
check "task visible after sync" bash -c "jq -e '.tasks[] | select(.content==\"Smoke task\")' <<<'$(body_of "$r")'"
r=$(api POST /api/v1/sync "{\"cursor\":null,\"commands\":[{\"type\":\"task_add\",\"uuid\":\"$CMD_ID\",\"args\":{\"id\":\"$TASK_ID\",\"content\":\"Smoke task\"}}]}")
check "replayed command is idempotent" \
  test "$(docker exec "${PROJECT}-db-1" psql -U bokydo -d bokydo -Atc "select count(*) from tasks where content='Smoke task'")" = 1
CMD2=$(cat /proc/sys/kernel/random/uuid)
r=$(api POST /api/v1/sync "{\"commands\":[{\"type\":\"user_update_preferences\",\"uuid\":\"$CMD2\",\"args\":{\"timezone\":\"Asia/Phnom_Penh\",\"appearance\":{\"darkTheme\":\"catppuccin-mocha\"}}}]}")
check "preferences saved and synced" bash -c "jq -e '.user.preferences.timezone == \"Asia/Phnom_Penh\" and .user.preferences.appearance.darkTheme == \"catppuccin-mocha\"' <<<'$(body_of "$r")'"
# W3: a recurring task rolls forward on completion; rules outside the supported subset are refused.
REC_ID=$(cat /proc/sys/kernel/random/uuid)
DUE='{"date":"2020-01-06","time":null,"timezone":null,"string":"every mon","recurrence":{"rrule":"FREQ=WEEKLY;BYDAY=MO","anchor":"scheduled"}}'
r=$(api POST /api/v1/sync "{\"commands\":[{\"type\":\"task_add\",\"uuid\":\"$(cat /proc/sys/kernel/random/uuid)\",\"args\":{\"id\":\"$REC_ID\",\"content\":\"Weekly smoke\",\"due\":$DUE}},{\"type\":\"task_complete\",\"uuid\":\"$(cat /proc/sys/kernel/random/uuid)\",\"args\":{\"id\":\"$REC_ID\"}}]}")
check "recurring task moves to its next Monday and stays open" bash -c "jq -e '.tasks[] | select(.id==\"$REC_ID\") | (.isCompleted == false) and (.due.date > \"2020-01-06\")' <<<'$(body_of "$r")'"
BAD=$(cat /proc/sys/kernel/random/uuid)
r=$(api POST /api/v1/sync "{\"commands\":[{\"type\":\"task_add\",\"uuid\":\"$BAD\",\"args\":{\"id\":\"$(cat /proc/sys/kernel/random/uuid)\",\"content\":\"x\",\"due\":{\"date\":\"2026-01-01\",\"time\":null,\"timezone\":null,\"string\":\"x\",\"recurrence\":{\"rrule\":\"FREQ=SECONDLY\",\"anchor\":\"scheduled\"}}}}]}")
check "unsupported recurrence rule refused" bash -c "jq -e '.results[\"$BAD\"].error == \"invalid\"' <<<'$(body_of "$r")'"
# W4: filters run server-side as parameterised SQL; bad queries get a positioned error.
check "filter endpoint runs a query" bash -c "jq -e 'any(.lists[0].tasks[]; .content == \"Smoke task\")' <<<'$(body_of "$(api GET "/api/v1/tasks/filter?query=search%3A%20smoke%20%26%20no%20date")")'"
r=$(api GET "/api/v1/tasks/filter?query=today%20%7C%20bogus")
check "invalid filter is a 400 with a position" bash -c "[[ $(status_of "$r") == 400 ]] && jq -e '.error == \"invalid_filter\" and .start == 8' <<<'$(body_of "$r")'"
check "full-text search finds the task" bash -c "jq -e 'any(.tasks[]; .content == \"Smoke task\")' <<<'$(body_of "$(api GET '/api/v1/search?q=smok')")'"
check "search treats query syntax as text" test "$(status_of "$(api GET "/api/v1/search?q=%27%20%7C%20%21x%3A*")")" = 200
check "completed-tasks endpoint answers" test "$(status_of "$(api GET /api/v1/tasks/completed)")" = 200
check "event stream opens for a signed-in user" \
  bash -c "curl -s -m 2 -b '$JAR' -o /dev/null -w '%{content_type}' $BASE/api/v1/sync/events | grep -q text/event-stream"
check "event stream refuses anonymous users" \
  test "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$BASE/api/v1/sync/events")" = 401

echo "== account security (W1)"
# Latest email to an address, and the token from its link (tokens travel in the URL fragment).
mail_token() {
  local id
  id=$(curl -s "$MAILPIT/api/v1/search?query=to:$1" | jq -r '.messages[0].ID')
  curl -s "$MAILPIT/api/v1/message/$id" | jq -r .Text | grep -o '#[A-Za-z0-9_-]\{43\}' | head -1 | cut -c2-
}
totp() { # totp <base32 secret> <step offset>
  node -e 'const c=require("crypto"),A="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";let b=0,v=0,o=[];for(const ch of process.argv[1]){v=(v<<5)|A.indexOf(ch);b+=5;if(b>=8){o.push((v>>>(b-8))&255);b-=8}}const m=Buffer.alloc(8);m.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)+Number(process.argv[2])));const h=c.createHmac("sha1",Buffer.from(o)).update(m).digest(),f=h[h.length-1]&15;console.log(String((h.readUInt32BE(f)&0x7fffffff)%1e6).padStart(6,"0"))' "$1" "$2"
}
r=$(api PUT /api/v1/account/email '{"email":"admin@example.com"}')
check "email change sends a verification link" bash -c "jq -e .verificationSent <<<'$(body_of "$r")'"
sleep 1
VERIFY=$(mail_token admin@example.com)
check "email verified from the emailed link" test "$(status_of "$(api POST /api/v1/auth/email/verify "{\"token\":\"$VERIFY\"}")")" = 204
check "reset request for an unknown user looks identical" \
  test "$(body_of "$(api POST /api/v1/auth/password-reset '{"login":"nobody"}')")" = '{"ok":true}'
api POST /api/v1/auth/password-reset '{"login":"admin"}' >/dev/null
sleep 1
RESET=$(mail_token admin@example.com)
NEWPW2='harbor-velvet-cactus-meadow-smoke'
check "password reset via emailed link" \
  test "$(status_of "$(api POST /api/v1/auth/password-reset/complete "{\"token\":\"$RESET\",\"newPassword\":\"$NEWPW2\"}")")" = 204
check "reset link is single-use" \
  test "$(status_of "$(api POST /api/v1/auth/password-reset/complete "{\"token\":\"$RESET\",\"newPassword\":\"$NEWPW2-again\"}")")" = 400
CSRF=""; : > "$JAR"
r=$(api POST /api/v1/auth/login "{\"username\":\"admin@example.com\",\"password\":\"$NEWPW2\"}")
check "sign in with verified email and new password" test "$(status_of "$r")" = 200
CSRF=$(body_of "$r" | jq -r .csrfToken)
r=$(api POST /api/v1/account/totp/setup)
SECRET=$(body_of "$r" | jq -r .secret)
r=$(api POST /api/v1/account/totp/confirm "{\"code\":\"$(totp "$SECRET" 0)\"}")
check "TOTP enrolled, 10 recovery codes issued" test "$(body_of "$r" | jq '.recoveryCodes | length')" = 10
api POST /api/v1/auth/logout >/dev/null; CSRF=""; : > "$JAR"
r=$(api POST /api/v1/auth/login "{\"username\":\"admin\",\"password\":\"$NEWPW2\"}")
check "password alone now asks for a second factor" bash -c "jq -e .mfaRequired <<<'$(body_of "$r")'"
check "no session before the second factor" test "$(status_of "$(api GET /api/v1/auth/session)")" = 401
r=$(api POST /api/v1/auth/mfa/totp "{\"code\":\"$(totp "$SECRET" 1)\"}")
check "TOTP completes sign-in" bash -c "[[ \"$(body_of "$r" | jq -r .authMethod)\" == password+totp ]]"
CSRF=$(body_of "$r" | jq -r .csrfToken)

echo "== collaboration (W5)"
uuid() { cat /proc/sys/kernel/random/uuid; }
sync_cmds() { api POST /api/v1/sync "{\"commands\":[$1]}"; } # sync_cmds <comma-separated commands>
cmd() { echo "{\"type\":\"$1\",\"uuid\":\"$(uuid)\",\"args\":$2}"; }
ADMIN_CSRF=$CSRF
as_admin() { JAR=$ADMIN_JAR; CSRF=$ADMIN_CSRF; }
as_sam() { JAR=$SAM_JAR; CSRF=$SAM_CSRF; }
r=$(api POST /api/v1/admin/users '{"username":"sam"}')
check "admin creates a second user" test "$(status_of "$r")" = 200
SAM_PASS=$(body_of "$r" | jq -r .passphrase)
JAR=$SAM_JAR; CSRF=""
r=$(api POST /api/v1/auth/login "{\"username\":\"sam\",\"password\":\"$SAM_PASS\"}")
CSRF=$(body_of "$r" | jq -r .csrfToken)
r=$(api POST /api/v1/auth/password "{\"currentPassword\":\"$SAM_PASS\",\"newPassword\":\"lagoon-thistle-copper-banjo-smoke\"}")
SAM_CSRF=$(body_of "$r" | jq -r .csrfToken)
check "second user signs in" test "$(status_of "$r")" = 200
as_admin
PROJ=$(uuid); SHARED_TASK=$(uuid)
sync_cmds "$(cmd project_add "{\"id\":\"$PROJ\",\"name\":\"Smoke team\"}"),$(cmd task_add "{\"id\":\"$SHARED_TASK\",\"projectId\":\"$PROJ\",\"content\":\"Shared smoke\"}")" >/dev/null
r=$(api POST "/api/v1/projects/$PROJ/invites" '{"role":"owner"}')
check "invite role can't be owner" test "$(status_of "$r")" = 400
r=$(api POST "/api/v1/projects/$PROJ/invites" '{"role":"editor"}')
LINK=$(body_of "$r" | jq -r .token)
check "one-time invite link created" test "${#LINK}" -ge 43
as_sam
check "invite link joins the project" \
  bash -c "jq -e '.projectId == \"$PROJ\"' <<<'$(body_of "$(api POST /api/v1/invites/link/accept "{\"token\":\"$LINK\"}")")'"
check "invite link is single-use" test "$(status_of "$(api POST /api/v1/invites/link/accept "{\"token\":\"$LINK\"}")")" = 404
check "member syncs the shared project as editor" \
  bash -c "jq -e '.projects[] | select(.id==\"$PROJ\") | .role == \"editor\"' <<<'$(body_of "$(api POST /api/v1/sync '{"cursor":null}')")'"
as_admin
UP=$(curl -s -b "$JAR" -H "Origin: $BASE" -H "x-csrf-token: $CSRF" -H 'content-type: application/octet-stream' \
  -H 'x-filename: evil.html' --data-binary '<html><script>alert(1)</script></html>' "$BASE/api/v1/projects/$PROJ/attachments")
ATT=$(jq -r .id <<<"$UP")
check "upload type is sniffed, not taken from the name" bash -c "jq -e '.contentType != \"text/html\"' <<<'$UP'"
r=$(sync_cmds "$(cmd comment_add "{\"id\":\"$(uuid)\",\"taskId\":\"$SHARED_TASK\",\"content\":\"See file @sam\",\"attachmentIds\":[\"$ATT\"]}")")
check "comment with attachment and mention saved" bash -c "jq -e '[.results[]] | all(.ok)' <<<'$(body_of "$r")'"
as_sam
check "mention notifies the member" \
  bash -c "jq -e 'any(.notifications[]; .type == \"mentioned\")' <<<'$(body_of "$(api POST /api/v1/sync '{"cursor":null}')")'"
HDRS=$(curl -s -D - -o /dev/null -b "$JAR" "$BASE/api/v1/attachments/$ATT?inline=1")
check "member downloads the attachment" grep -q '^HTTP/1.1 200' <<<"$HDRS"
check "attachment served sandboxed and nosniff" \
  bash -c "grep -qi \"^content-security-policy: default-src 'none'; sandbox\" <<<\"\$0\" && grep -qi '^x-content-type-options: nosniff' <<<\"\$0\"" "$HDRS"
check "non-image attachment is never inline" grep -qi '^content-disposition: attachment' <<<"$HDRS"
as_admin
SAM_ID=$(body_of "$(api POST /api/v1/sync '{"cursor":null}')" | jq -r '.collaborators[] | select(.username=="sam") | .id')
sync_cmds "$(cmd project_member_remove "{\"projectId\":\"$PROJ\",\"userId\":\"$SAM_ID\"}")" >/dev/null
as_sam
check "removed member loses the attachment" test "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/api/v1/attachments/$ATT")" = 404
check "removed member's sync drops the project" \
  bash -c "jq -e 'all(.projects[]; .id != \"$PROJ\")' <<<'$(body_of "$(api POST /api/v1/sync '{"cursor":null}')")'"
as_admin
WS=$(uuid); WS_PROJ=$(uuid)
sync_cmds "$(cmd workspace_add "{\"id\":\"$WS\",\"name\":\"Smoke Co\"}"),$(cmd project_add "{\"id\":\"$WS_PROJ\",\"name\":\"Team plans\",\"workspaceId\":\"$WS\"}")" >/dev/null
check "team invite by username" test "$(status_of "$(api POST "/api/v1/workspaces/$WS/invites" '{"identifier":"sam","role":"member"}')")" = 202
as_sam
INV=$(body_of "$(api GET /api/v1/invites)" | jq -r '.invites[] | select(.kind=="workspace") | .id')
check "member accepts the team invite" test "$(status_of "$(api POST "/api/v1/invites/$INV/accept")")" = 200
check "team member gets team-visible projects" \
  bash -c "jq -e '.projects[] | select(.id==\"$WS_PROJ\") | .role == \"editor\"' <<<'$(body_of "$(api POST /api/v1/sync '{"cursor":null}')")'"
check "team member can't invite (admins only)" \
  test "$(status_of "$(api POST "/api/v1/workspaces/$WS/invites" '{"role":"member"}')")" = 403
as_admin

echo "== reminders & notifications (W6)"
check "push key is a P-256 public key" \
  test "$(body_of "$(api GET /api/v1/push/key)" | jq -r '.publicKey | length')" = 87
r=$(api POST /api/v1/push/subscriptions '{"endpoint":"https://169.254.169.254/latest/meta-data/","keys":{"p256dh":"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4","auth":"BTBZMqHH6r4Tts7J_aSIgg"}}') # gitleaks:allow (RFC 8291 example keys)
check "push endpoints outside known push services are refused (SSRF)" \
  bash -c "[[ $(status_of "$r") == 400 ]] && jq -e '.error == \"unsupported_push_service\"' <<<'$(body_of "$r")'"
# A real reminder: due two minutes from now (the smoke admin's zone), reminded one minute before.
DUE_DAY=$(TZ=Asia/Phnom_Penh date -d '+2 min' +%F); DUE_TIME=$(TZ=Asia/Phnom_Penh date -d '+2 min' +%H:%M)
REM_TASK=$(uuid)
sync_cmds "$(cmd user_update_preferences '{"notifications":{"channels":{"reminder":{"email":true}}}}'),$(cmd task_add "{\"id\":\"$REM_TASK\",\"content\":\"Smoke reminder\",\"due\":{\"date\":\"$DUE_DAY\",\"time\":\"$DUE_TIME\",\"timezone\":null,\"string\":\"x\",\"recurrence\":null}}"),$(cmd reminder_add "{\"id\":\"$(uuid)\",\"taskId\":\"$REM_TASK\",\"type\":\"relative\",\"minutesBefore\":1}")" >/dev/null
reminder_mail() { curl -s "$MAILPIT/api/v1/search?query=subject:%22Smoke%20reminder%22" | jq -r '.messages[0].ID // empty'; }
for _ in $(seq 50); do [[ -n "$(reminder_mail)" ]] && break; sleep 3; done
REM_MAIL=$(reminder_mail)
check "reminder fires on time and is emailed" test -n "$REM_MAIL"
check "reminder shows in the in-app inbox" \
  bash -c "jq -e 'any(.notifications[]; .type == \"reminder\")' <<<'$(body_of "$(api POST /api/v1/sync '{"cursor":null}')")'"
check "notification email has List-Unsubscribe" \
  bash -c "curl -s $MAILPIT/api/v1/message/$REM_MAIL/headers | jq -e '.\"List-Unsubscribe\"[0] | test(\"/unsubscribe#\")'"
UNSUB=$(curl -s "$MAILPIT/api/v1/message/$REM_MAIL" | jq -r .Text | grep -o 'unsubscribe#[A-Za-z0-9._-]*' | head -1 | cut -d'#' -f2)
check "forged unsubscribe token is refused" \
  test "$(status_of "$(api POST /api/v1/notifications/unsubscribe "{\"token\":\"${UNSUB%?}x\"}")")" = 400
check "signed unsubscribe link turns that email off" \
  bash -c "[[ $(status_of "$(api POST /api/v1/notifications/unsubscribe "{\"token\":\"$UNSUB\"}")") == 200 ]]"
check "unsubscribe changed only that preference" \
  bash -c "jq -e '.user.preferences.notifications.channels | (.reminder.email == false) and (.assigned.email == true)' <<<'$(body_of "$(api POST /api/v1/sync '{"cursor":null}')")'"

echo "== calendar feeds (W11d)"
INBOX=$(body_of "$(api POST /api/v1/sync '{"cursor":null}')" | jq -r .user.inboxProjectId)
FEED=$(body_of "$(api POST /api/v1/calendar-feeds "{\"kind\":\"project\",\"targetId\":\"$INBOX\"}")")
FEED_ID=$(jq -r .id <<<"$FEED"); FEED_TOKEN=$(jq -r .url <<<"$FEED"); FEED_TOKEN=${FEED_TOKEN##*/}; FEED_TOKEN=${FEED_TOKEN%.ics}
FEED_PATH=/api/v1/calendar/$FEED_TOKEN.ics
check "feed link carries a 256-bit secret" bash -c "[[ '$FEED_TOKEN' =~ ^[A-Za-z0-9_-]{43}$ ]]"
FEED_RES=$(curl -s -D - "$BASE$FEED_PATH") # no cookie: the link is the credential
feed_has() { grep -qi -- "$1" <<<"$FEED_RES"; }
check "feed is served without a session, as text/calendar" feed_has '^content-type: text/calendar'
check "feed lists tasks that have a due date" feed_has '^SUMMARY:Smoke reminder'
check "feed link needs the exact secret" test "$(http_code "$BASE/api/v1/calendar/${FEED_TOKEN%?}x.ics")" = 404
check "database holds only a hash of the link" \
  test "$(docker exec "${PROJECT}-db-1" psql -U bokydo -d bokydo -Atc "select count(*) from calendar_feeds where token_id = '$FEED_TOKEN'")" = 0
check "feed link stays out of the logs" \
  bash -c "! ${C[*]} logs app 2>&1 | grep -q '$FEED_TOKEN' && ${C[*]} logs app 2>&1 | grep -q 'calendar/\[redacted\]'"
check "revoking a feed kills its link at once" \
  bash -c "[[ $(status_of "$(api DELETE /api/v1/calendar-feeds/$FEED_ID)") == 204 && $(http_code "$BASE$FEED_PATH") == 404 ]]"

echo "== templates (W11b)"
# Importing a template is just ordinary sync commands, so the server vets every row of it like any
# other write: validation, nesting limits and who may write where. Each refusal below is paired
# with the same command succeeding without the one thing under test, so it can't pass by accident.
as_admin
all_ok() { jq -e '[.results[]?.ok] | all' <<<"$1"; }
result_is() { jq -e --arg u "$2" --argjson want "$3" '.results[$u].ok == $want' <<<"$1"; } # result_is <body> <uuid> <true|false>
refused_because() { jq -e --arg u "$2" --arg why "$3" '.results[$u] | (.ok == false) and (((.error // "") + " " + (.message // "")) | test($why))' <<<"$1"; }
accepted_count() { jq '[.results[] | select(.ok)] | length' <<<"$1"; }
IMP=$(uuid); IMP_SEC=$(uuid); IMP_T1=$(uuid); IMP_T2=$(uuid)
r=$(sync_cmds "$(cmd project_add "{\"id\":\"$IMP\",\"name\":\"Imported template\"}"),$(cmd section_add "{\"id\":\"$IMP_SEC\",\"projectId\":\"$IMP\",\"name\":\"Section\",\"sectionOrder\":\"a0\"}"),$(cmd task_add "{\"id\":\"$IMP_T1\",\"projectId\":\"$IMP\",\"sectionId\":\"$IMP_SEC\",\"childOrder\":\"a0\",\"content\":\"=SUM(A1)\",\"description\":\"<img src=x onerror=alert(1)>\\nline two\"}"),$(cmd task_add "{\"id\":\"$IMP_T2\",\"projectId\":\"$IMP\",\"parentId\":\"$IMP_T1\",\"childOrder\":\"a0\",\"content\":\"Sub-task\"}"),$(cmd comment_add "{\"id\":\"$(uuid)\",\"taskId\":\"$IMP_T1\",\"content\":\"[x](javascript:alert(1))\"}")")
check "a template-shaped batch (project, section, sub-task, comment) is accepted" all_ok "$(body_of "$r")"
stored_literally() { jq -e --arg id "$IMP_T1" '.tasks[] | select(.id == $id) | (.content == "=SUM(A1)") and (.description | startswith("<img src=x"))' <<<"$1"; }
check "imported text is stored as plain text" stored_literally "$(body_of "$(api POST /api/v1/sync '{"cursor":null}')")"

# Control characters: the same task is fine with a clean title and refused with a control character.
ROW_OK=$(cmd task_add "{\"id\":\"$(uuid)\",\"projectId\":\"$IMP\",\"childOrder\":\"a1\",\"content\":\"clean title\"}")
ROW_BAD=$(cmd task_add "{\"id\":\"$(uuid)\",\"projectId\":\"$IMP\",\"childOrder\":\"a2\",\"content\":\"bad\\u0007title\"}")
r=$(sync_cmds "$ROW_OK,$ROW_BAD")
check "a clean title is accepted" result_is "$(body_of "$r")" "$(jq -r .uuid <<<"$ROW_OK")" true
check "a control character in a title is refused for that reason" \
  refused_because "$(body_of "$r")" "$(jq -r .uuid <<<"$ROW_BAD")" "single line"

# Nesting: five levels are fine, the sixth is refused for being too deep (every key here is valid).
CHAIN=""; PREV=""
for i in 1 2 3 4 5 6; do
  ID=$(uuid); PARENT=""; [[ -n "$PREV" ]] && PARENT=",\"parentId\":\"$PREV\""
  ROW=$(cmd task_add "{\"id\":\"$ID\",\"projectId\":\"$IMP\",\"childOrder\":\"a0\",\"content\":\"Level $i\"$PARENT}")
  CHAIN="${CHAIN:+$CHAIN,}$ROW"; PREV=$ID; DEEPEST=$(jq -r .uuid <<<"$ROW")
done
r=$(sync_cmds "$CHAIN")
check "nesting is accepted down to the depth limit" test "$(accepted_count "$(body_of "$r")")" = 5
check "the task nested too deeply is refused for that reason" \
  refused_because "$(body_of "$r")" "$DEEPEST" "too deeply nested"

# Permissions: the same row is accepted from the project's owner and refused from someone else.
SAM_ROW=$(cmd task_add "{\"id\":\"$(uuid)\",\"projectId\":\"$IMP\",\"childOrder\":\"a3\",\"content\":\"Added by the owner\"}")
check "the owner can add to the imported project" \
  result_is "$(body_of "$(sync_cmds "$SAM_ROW")")" "$(jq -r .uuid <<<"$SAM_ROW")" true
as_sam
SAM_ROW=$(cmd task_add "{\"id\":\"$(uuid)\",\"projectId\":\"$IMP\",\"childOrder\":\"a4\",\"content\":\"Not mine\"}")
check "an import can't write into a project the user can't edit" \
  refused_because "$(body_of "$(sync_cmds "$SAM_ROW")")" "$(jq -r .uuid <<<"$SAM_ROW")" "not_found"
as_admin
check "the Templates page is served by the web app" test "$(http_code -H 'accept: text/html' "$BASE/templates")" = 200

echo "== accessibility (W12b)"
# Single-key shortcuts can be turned off (WCAG 2.1.4): the server stores a boolean and only a boolean.
shortcuts_off() { jq -e '.user.preferences.keyboardShortcuts == false' <<<"$1"; }
shortcuts_on() { jq -e '.user.preferences.keyboardShortcuts == true' <<<"$1"; }
check "single-key shortcuts are on by default" shortcuts_on "$(body_of "$(api POST /api/v1/sync '{"cursor":null}')")"
C_OFF=$(cmd user_update_preferences '{"keyboardShortcuts":false}')
check "turning them off is accepted" result_is "$(body_of "$(sync_cmds "$C_OFF")")" "$(jq -r .uuid <<<"$C_OFF")" true
check "and persists" shortcuts_off "$(body_of "$(api POST /api/v1/sync '{"cursor":null}')")"
C_BAD=$(cmd user_update_preferences '{"keyboardShortcuts":"no"}')
check "a non-boolean value is refused" result_is "$(body_of "$(sync_cmds "$C_BAD")")" "$(jq -r .uuid <<<"$C_BAD")" false
C_ON=$(cmd user_update_preferences '{"keyboardShortcuts":true}')
sync_cmds "$C_ON" >/dev/null
check "and they can be turned back on" shortcuts_on "$(body_of "$(api POST /api/v1/sync '{"cursor":null}')")"

echo "== AI provider layer (W7a)"
r=$(api POST /api/v1/admin/ai/credentials '{"provider":"openai-compatible","label":"Mailpit as a model server","baseUrl":"http://mailpit:8025/api/v1","apiKey":"smoke-ai-secret-key"}')
check "instance AI credential saved" test "$(status_of "$r")" = 201
check "AI key is write-only" bash -c "! grep -q smoke-ai-secret <<<'$(body_of "$r")'"
AI_CRED=$(body_of "$r" | jq -r .id)
check "AI key encrypted at rest" \
  bash -c "! docker exec ${PROJECT}-db-1 psql -U bokydo -d bokydo -Atc \"select secret::text from ai_credentials\" | grep -q smoke-ai-secret"
check "private network unreachable until allow-listed (SSRF)" \
  bash -c "jq -e '.error == \"blocked_address\"' <<<'$(body_of "$(api POST "/api/v1/admin/ai/credentials/$AI_CRED/test")")'"
api PATCH /api/v1/admin/settings '{"network.privateAllowlist":["mailpit"]}' >/dev/null
check "allow-listed private host is reached (and answers 404)" \
  bash -c "jq -e '.error == \"unexpected_status\" and .status == 404' <<<'$(body_of "$(api POST "/api/v1/admin/ai/credentials/$AI_CRED/test")")'"
check "metadata address refused even for admins" \
  test "$(status_of "$(api POST /api/v1/admin/ai/credentials '{"provider":"ollama","label":"x","baseUrl":"http://169.254.169.254/latest"}')")" = 400
r=$(api POST /api/v1/ai/credentials '{"provider":"ollama","label":"Mine","baseUrl":"https://mailpit:8025/v1"}')
check "own credentials can't reach allow-listed private hosts" \
  bash -c "jq -e '.error == \"blocked_address\"' <<<'$(body_of "$(api POST "/api/v1/ai/credentials/$(body_of "$r" | jq -r .id)/test")")'"
check "own credentials need https" \
  test "$(status_of "$(api POST /api/v1/ai/credentials '{"provider":"ollama","label":"x","baseUrl":"http://models.example.com/v1"}')")" = 400
check "AI key never logged" bash -c "! ${C[*]} logs app 2>&1 | grep -q smoke-ai-secret"

echo "== public API auth: OAuth 2.1 and personal access tokens (W10a)"
check "OAuth metadata names this instance as issuer" \
  test "$(curl -s "$BASE/.well-known/oauth-authorization-server" | jq -r .issuer)" = "$BASE"
oauth_post() { curl -s -X POST -H 'content-type: application/json' --data "$2" "$BASE$1"; }
check "client registration refuses non-loopback http redirects" \
  test "$(oauth_post /oauth/register '{"redirect_uris":["http://evil.example/cb"]}' | jq -r .error)" = invalid_redirect_uri
CLIENT=$(oauth_post /oauth/register '{"redirect_uris":["https://client.example/cb"],"client_name":"Smoke client"}' | jq -r .client_id)
check "client registered dynamically" bash -c "[[ $CLIENT == bkdc_* ]]"
VERIFIER=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')
AUTHZ="$BASE/oauth/authorize?response_type=code&client_id=$CLIENT&code_challenge=$CHALLENGE&code_challenge_method=S256&scope=sync&state=st"
check "unregistered redirect URI gets an error page, never a redirect" \
  test "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$AUTHZ&redirect_uri=https://evil.example/cb")" = "400 "
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' "$AUTHZ&redirect_uri=https://client.example/cb")
check "authorization request goes to the consent page" bash -c "[[ '$LOC' == $BASE/oauth/consent#* ]]"
r=$(api POST /api/v1/oauth/request/decision "{\"request\":\"${LOC#*#}\",\"approve\":true}")
CODE=$(body_of "$r" | jq -r .redirect | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
check "consent returns a code to the registered redirect" bash -c "[[ -n '$CODE' ]]"
token_req() { curl -s -X POST -H 'content-type: application/x-www-form-urlencoded' --data "$1" "$BASE/oauth/token"; }
TOKENS=$(token_req "grant_type=authorization_code&code=$CODE&redirect_uri=https://client.example/cb&client_id=$CLIENT&code_verifier=$VERIFIER")
AT=$(jq -r .access_token <<<"$TOKENS")
bearer_sync() { curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $1" -H 'content-type: application/json' --data '{"cursor":null}' "$BASE/api/v1/sync"; }
check "access token works for sync" test "$(bearer_sync "$AT")" = 200
check "bearer tokens can't reach session-only routes" \
  test "$(curl -s -H "authorization: Bearer $AT" "$BASE/api/v1/account/tokens" | jq -r .error)" = token_not_accepted
check "replayed code is refused and revokes its tokens" \
  bash -c "[[ \$(jq -r .error <<<'$(token_req "grant_type=authorization_code&code=$CODE&redirect_uri=https://client.example/cb&client_id=$CLIENT&code_verifier=$VERIFIER")') == invalid_grant && $(bearer_sync "$AT") == 401 ]]"
api POST /api/v1/auth/reauth "{\"password\":\"$NEWPW2\"}" >/dev/null
r=$(api POST /api/v1/account/tokens '{"name":"smoke","scopes":["sync"],"expiresInDays":1}')
PAT=$(body_of "$r" | jq -r .token)
check "personal access token created and works" bash -c "[[ $(status_of "$r") == 201 && $(bearer_sync "$PAT") == 200 ]]"
check "tokens stored only as hashes" \
  bash -c "! docker exec ${PROJECT}-db-1 psql -U bokydo -d bokydo -Atc 'select hash from api_tokens' | grep -q '${PAT#bkd_pat_}'"
check "tokens never logged" bash -c "! ${C[*]} logs app 2>&1 | grep -q -e '${PAT#bkd_pat_}' -e '${AT#bkd_at_}'"
api DELETE "/api/v1/account/tokens/$(body_of "$r" | jq -r .pat.id)" >/dev/null
check "revoked token stops working" test "$(bearer_sync "$PAT")" = 401

echo "== MCP server (W10c)"
mcp() { curl -s -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "${@:2}" --data "$1" "$BASE/mcp"; }
check "MCP asks for a token and points to its metadata" \
  bash -c "curl -s -D - -o /dev/null -X POST -H 'content-type: application/json' --data '{}' $BASE/mcp | grep -qi 'resource_metadata=\"$BASE/.well-known/oauth-protected-resource/mcp\"'"
check "MCP resource metadata published" \
  test "$(curl -s "$BASE/.well-known/oauth-protected-resource/mcp" | jq -r .resource)" = "$BASE/mcp"
r=$(api POST /api/v1/account/tokens '{"name":"mcp","scopes":["tasks:read","tasks:write"],"expiresInDays":1}')
MCPT=$(body_of "$r" | jq -r .token)
check "MCP initialize with a token" \
  test "$(mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' -H "authorization: Bearer $MCPT" | jq -r .result.protocolVersion)" = 2025-06-18
check "MCP refuses a foreign Origin" \
  test "$(mcp '{"jsonrpc":"2.0","id":1,"method":"ping"}' -H "authorization: Bearer $MCPT" -H 'origin: https://evil.example' -o /dev/null -w '%{http_code}')" = 403
check "MCP lists only the token's tools" \
  test "$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' -H "authorization: Bearer $MCPT" | jq -r '[.result.tools[].name] | sort | join(",")')" = "add_task,complete_task,get_report,get_task,run_filter,search_tasks,update_task"
check "MCP adds a task from natural language" \
  test "$(mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_task","arguments":{"text":"Smoke via MCP tomorrow p1"}}}' -H "authorization: Bearer $MCPT" | jq -r '.result.structuredContent.task | "\(.content) \(.priority)"')" = "Smoke via MCP p1"
api DELETE "/api/v1/account/tokens/$(body_of "$r" | jq -r .pat.id)" >/dev/null

echo "== Android foundation (A1)"
check "app discovery describes this instance" \
  test "$(curl -s "$BASE/.well-known/bokydo" | jq -r '"\(.publicUrl) \(.android.clientId) \(.android.redirectUri)"')" = "$BASE bkdc_bokydo-android-app-001 com.bokyapps.bokydo:/oauth2redirect"
check "Android app is a first-party OAuth client" \
  bash -c "[[ \$(curl -s -o /dev/null -w '%{redirect_url}' '$BASE/oauth/authorize?response_type=code&client_id=bkdc_bokydo-android-app-001&redirect_uri=com.bokyapps.bokydo%3A%2Foauth2redirect&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&scope=sync') == $BASE/oauth/consent#* ]]"
check "asset links empty until fingerprints are configured" test "$(curl -s "$BASE/.well-known/assetlinks.json")" = "[]"

echo "== restarts & recovery"
"${C[@]}" restart app >/dev/null 2>&1
sleep 5
check "restart creates no second admin" \
  test "$(docker exec "${PROJECT}-db-1" psql -U bokydo -d bokydo -Atc 'select count(*) from users where is_admin')" = 1
"${C[@]}" restart >/dev/null 2>&1
for _ in $(seq 60); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "${PROJECT}-app-1" 2>/dev/null)" == healthy ]] && break
  sleep 2
done
check "whole stack restarts cleanly" test "$(curl -s "$BASE/api/v1/instance" | jq -r .setupComplete)" = true
check "restarts keep the database password" \
  test "$(volume db-secret sha256sum /v/password | cut -d' ' -f1)" = "$DB_PW_HASH"
check "CLI reset-password works" bash -c "${C[*]} exec -T app bokydo admin reset-password admin | grep -q 'Passphrase: [a-z]'"
check "CLI reset-password rejects unknown user" bash -c "! ${C[*]} exec -T app bokydo admin reset-password nobody"
check "CLI reset-mfa works" bash -c "${C[*]} exec -T app bokydo admin reset-mfa admin | grep -q removed"
check "CLI clear-public-url works" bash -c "${C[*]} exec -T app bokydo admin clear-public-url | grep -q cleared"
check "reset revokes existing sessions" test "$(status_of "$(api GET /api/v1/auth/session)")" = 401
check "reset is audited" \
  test "$(docker exec "${PROJECT}-db-1" psql -U bokydo -d bokydo -Atc "select count(*) from audit_log where action='user.password_reset_cli'")" = 1

echo "== losing both database password copies (docs/recovery.md)"
"${C[@]}" stop app db >/dev/null 2>&1
volume_rw app-data rm -f /v/secrets/db_password
volume_rw db-secret rm -f /v/password
PORT=$PORT "${C[@]}" up -d >/dev/null 2>&1
# The app generates a fresh pair and publishes it, but Postgres still expects the old password.
for _ in $(seq 30); do
  [[ -n "$(volume db-secret sh -c 'cat /v/password 2>/dev/null')" ]] && break
  sleep 1
done
NEW_PW=$(volume db-secret cat /v/password)
printf "%s\n" "ALTER ROLE bokydo WITH PASSWORD :'pw';" \
  | "${C[@]}" exec -T db psql -U bokydo -d bokydo -v pw="$NEW_PW" >/dev/null 2>&1
for _ in $(seq 60); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "${PROJECT}-app-1" 2>/dev/null)" == healthy ]] && break
  sleep 2
done
check "app recovers after both password copies are lost" \
  test "$(docker inspect -f '{{.State.Health.Status}}' "${PROJECT}-app-1")" = healthy
check "recovery kept the database (same admin, not a fresh one)" \
  test "$(docker exec "${PROJECT}-db-1" psql -U bokydo -d bokydo -Atc 'select count(*) from users where is_admin')" = 1
check "recovery leaves one agreed password in both copies" \
  test "$(volume db-secret sha256sum /v/password | cut -d' ' -f1)" = "$(volume app-data sha256sum /v/secrets/db_password | cut -d' ' -f1)"

if [[ $fail == 0 ]]; then echo "== all checks passed"; else echo "== FAILURES"; "${C[@]}" logs --tail 50; fi
exit $fail
