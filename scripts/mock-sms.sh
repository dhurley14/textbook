#!/usr/bin/env bash
# Posts a mock Twilio inbound-SMS payload to POST /sms, then waits for the agent's reply.
#
#   ./scripts/mock-sms.sh "any openings thursday afternoon?"
#   ./scripts/mock-sms.sh -i                       # interactive back-and-forth
#   ./scripts/mock-sms.sh -f +15551234567 "hi"     # pretend to be a different client
#
# The webhook acks immediately and does its work in the background, so this reads the reply back
# out of the message log rather than from the HTTP response.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
die() { echo "${RED}✗${OFF} $1" >&2; exit 1; }

ENV_FILE="${ENV_FILE:-.env.dev}"
[ -f "$ENV_FILE" ] || die "No ${ENV_FILE}. Run 'npm run dev' once to create it."

get_env() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }

APP_URL=$(get_env APP_URL); APP_URL=${APP_URL:-http://localhost:5173}
ACCOUNT_SID=$(get_env TWILIO_ACCOUNT_SID); ACCOUNT_SID=${ACCOUNT_SID:-ACmock}
AUTH_TOKEN=$(get_env TWILIO_AUTH_TOKEN)
VALIDATE=$(get_env VALIDATE_TWILIO_SIGNATURE)
DB_PATH=$(get_env DATABASE_PATH); DB_PATH=${DB_PATH:-./data/app.sqlite}

FROM="+15555550123"
TO=""
URL=""
INTERACTIVE=false
TIMEOUT=60

while [ $# -gt 0 ]; do
  case "$1" in
    -f|--from) FROM="$2"; shift 2 ;;
    -t|--to) TO="$2"; shift 2 ;;
    -u|--url) URL="$2"; shift 2 ;;
    -i|--interactive) INTERACTIVE=true; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) break ;;
  esac
done

URL=${URL:-${APP_URL%/}/sms}

# --- Resolve the barber's number -----------------------------------------------------------------
# `To` is the tenant key: the route looks up which barber owns the number the text was sent to.
#
# Queries run through node rather than the sqlite3 CLI, which isn't installed everywhere. Errors
# are deliberately not suppressed — a silently empty result is indistinguishable from a broken query.
sql() { node -e "$1" "$DB_PATH" "${@:2}"; }

db_missing() { [ ! -f "$DB_PATH" ]; }

if [ -z "$TO" ] && ! db_missing; then
  TO=$(sql '
    const Database = require("better-sqlite3");
    const db = new Database(process.argv[1], { readonly: true });
    const row = db.prepare("SELECT e164 FROM phone_numbers WHERE status = ? ORDER BY created_at LIMIT 1").get("active");
    if (row) process.stdout.write(row.e164);
  ')
fi

if [ -z "$TO" ]; then
  die "No activated number found in ${DB_PATH}.
  Sign in at ${APP_URL} and click 'Activate my number', or pass one with --to.
  Without a matching number the route has no tenant to route to and will ignore the message."
fi

# --- Twilio signature ----------------------------------------------------------------------------
# HMAC-SHA1 over the URL followed by each POST param's key and value, in alphabetical key order,
# base64 encoded. Params below are already listed alphabetically.
sign() {
  local body="$1" sid="$2"
  printf '%s' "${URL}AccountSid${ACCOUNT_SID}Body${body}From${FROM}MessageSid${sid}NumMedia0To${TO}" \
    | openssl dgst -sha1 -hmac "$AUTH_TOKEN" -binary \
    | openssl base64
}

send() {
  local body="$1"
  local sid="SM$(openssl rand -hex 16)"

  local -a args=(-s -o /dev/null -w '%{http_code}' -X POST "$URL"
    --data-urlencode "AccountSid=${ACCOUNT_SID}"
    --data-urlencode "Body=${body}"
    --data-urlencode "From=${FROM}"
    --data-urlencode "MessageSid=${sid}"
    --data-urlencode "NumMedia=0"
    --data-urlencode "To=${TO}")

  # Only sign when the server is actually checking; otherwise the auth token may be a placeholder.
  if [ "$VALIDATE" = "true" ]; then
    args+=(-H "X-Twilio-Signature: $(sign "$body" "$sid")")
  fi

  local code
  code=$(curl "${args[@]}") || die "Could not reach ${URL}. Is 'npm run dev' running?"

  case "$code" in
    200) ;;
    403) die "403 rejected signature. Check TWILIO_AUTH_TOKEN and that APP_URL (${APP_URL}) matches the URL you posted to." ;;
    404) die "404 from ${URL}. If you're posting to the Vite port, make sure /sms is proxied in vite.config.ts." ;;
    *) die "Unexpected HTTP ${code} from ${URL}." ;;
  esac
}

# --- Reply --------------------------------------------------------------------------------------
# The route responds before the model runs, so poll the transcript for the next assistant message.
watermark() {
  if db_missing; then echo 0; return; fi
  sql '
    const Database = require("better-sqlite3");
    const db = new Database(process.argv[1], { readonly: true });
    const row = db.prepare(`
      SELECT COALESCE(MAX(m.id), 0) AS id FROM messages m
      JOIN customers c ON c.id = m.customer_id
      JOIN phone_numbers p ON p.barber_id = c.barber_id
      WHERE c.phone = ? AND p.e164 = ?`).get(process.argv[2], process.argv[3]);
    process.stdout.write(String(row ? row.id : 0));
  ' "$FROM" "$TO"
}

await_reply() {
  local since="$1" deadline=$((SECONDS + TIMEOUT)) reply=""

  # Role and content are filtered in JS rather than with json_extract: SQLite treats double-quoted
  # strings as identifiers, and single quotes can't appear inside this shell-quoted snippet.
  while [ $SECONDS -lt $deadline ]; do
    reply=$(sql '
      const Database = require("better-sqlite3");
      const db = new Database(process.argv[1], { readonly: true });
      const rows = db.prepare(`
        SELECT m.payload FROM messages m
        JOIN customers c ON c.id = m.customer_id
        JOIN phone_numbers p ON p.barber_id = c.barber_id
        WHERE c.phone = ? AND p.e164 = ? AND m.id > ?
        ORDER BY m.id DESC LIMIT 20`).all(process.argv[2], process.argv[3], Number(process.argv[4]));
      for (const row of rows) {
        const message = JSON.parse(row.payload);
        if (message.role === "assistant" && message.content) {
          process.stdout.write(message.content);
          break;
        }
      }
    ' "$FROM" "$TO" "$since")

    if [ -n "$reply" ]; then
      printf '%s\n\n' "${BOLD}${TO} >${OFF} ${reply}"
      return 0
    fi
    sleep 1
  done

  echo "${YELLOW}!${OFF} No reply within ${TIMEOUT}s. Check the dev server log —"
  echo "  a placeholder OPENAI_API_KEY or an unconnected Google Calendar will both stall here."
  echo
}

exchange() {
  local text="$1"
  local since
  since=$(watermark)
  send "$text"
  await_reply "$since"
}

# --- Run -----------------------------------------------------------------------------------------
echo "${DIM}client ${FROM} → barber ${TO}  via ${URL}${OFF}"
echo

if [ "$INTERACTIVE" = true ] || [ $# -eq 0 ]; then
  echo "${DIM}Type a message, or Ctrl+C to quit.${OFF}"
  echo
  while IFS= read -r -p "${FROM} > " line; do
    [ -z "$line" ] && continue
    echo
    exchange "$line"
  done
else
  printf '%s\n\n' "${BOLD}${FROM} >${OFF} $*"
  exchange "$*"
fi
