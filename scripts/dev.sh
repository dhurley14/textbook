#!/usr/bin/env bash
# Starts a local dev environment: Express on :3000, Vite on :5173.
# Creates .env on first run and checks anything that would fail confusingly later.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

RED=$'\033[31m'; YELLOW=$'\033[33m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
warn() { echo "${YELLOW}!${OFF} $1"; }
info() { echo "${GREEN}✓${OFF} $1"; }

APP_PORT=3000
WEB_PORT=5173
WEB_URL="http://localhost:${WEB_PORT}"

# Local dev settings live here, not in .env, so they can't be confused with anything used for a
# real deployment. src/config.ts reads whichever file ENV_FILE names.
ENV_FILE=".env.dev"
export ENV_FILE

# --- Node 20+ -----------------------------------------------------------------------------------
# The `node` first on PATH is often an old system install, so fall back to an nvm-managed one
# rather than failing inside npm with a confusing native-build error.
node_major() { node -v 2>/dev/null | sed -n 's/^v\([0-9]*\).*/\1/p'; }

if [ "$(node_major || echo 0)" -lt 20 ] 2>/dev/null || [ -z "$(node_major || true)" ]; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
    nvm use 20 >/dev/null 2>&1 || nvm use --lts >/dev/null 2>&1 || true
  fi
fi

if [ "$(node_major || echo 0)" -lt 20 ] 2>/dev/null; then
  newest=$(ls -d "$HOME"/.nvm/versions/node/v2[0-9]* 2>/dev/null | sort -V | tail -1 || true)
  if [ -n "$newest" ]; then
    PATH="$newest/bin:$PATH"
    export PATH
  fi
fi

if [ "$(node_major || echo 0)" -lt 20 ] 2>/dev/null; then
  echo "${RED}✗${OFF} Node 20+ required, found $(node -v 2>/dev/null || echo 'none')."
  echo "  Install it with: nvm install 20"
  exit 1
fi

info "node $(node -v) ($(command -v node))"

# --- Dependencies -------------------------------------------------------------------------------
if [ ! -d node_modules ]; then
  info "installing dependencies"
  npm install
fi

# --- Environment --------------------------------------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  # Local defaults: browse Vite, and allow curling the webhook without a real Twilio signature.
  #
  # APP_URL points at Vite, not Express, because Google redirects the *browser* back to it and
  # Vite proxies /auth and /api through to the server. Pointing it at :3000 would land the browser
  # on a port that serves no UI in dev.
  perl -pi -e "s|^APP_URL=.*|APP_URL=${WEB_URL}|" "$ENV_FILE"
  perl -pi -e 's|^VALIDATE_TWILIO_SIGNATURE=.*|VALIDATE_TWILIO_SIGNATURE=false|' "$ENV_FILE"
  # Print replies to the server log instead of paying Twilio to deliver them.
  perl -pi -e 's|^SMS_TRANSPORT=.*|SMS_TRANSPORT=console|' "$ENV_FILE"
  info "created ${ENV_FILE} from .env.example"
fi

# Backfill for env files created before this setting existed.
if ! grep -qE '^SMS_TRANSPORT=' "$ENV_FILE"; then
  echo 'SMS_TRANSPORT=console' >> "$ENV_FILE"
  info "set SMS_TRANSPORT=console"
fi

# ENCRYPTION_KEY has no safe default, so mint one on first run.
if ! grep -qE '^ENCRYPTION_KEY=.+' "$ENV_FILE"; then
  key=$(openssl rand -hex 32)
  perl -pi -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${key}|" "$ENV_FILE"
  info "generated ENCRYPTION_KEY"
fi

get_env() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }

app_url=$(get_env APP_URL)
app_url=${app_url:-$WEB_URL}

# Values still on their .env.example placeholders. Each boots fine and then fails at the moment
# you actually use it, so say so up front.
declare -a missing=()
case "$(get_env GOOGLE_CLIENT_ID)" in ""|xxxx*) missing+=("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — sign-in will fail");; esac
case "$(get_env OPENAI_API_KEY)" in ""|sk-...) missing+=("OPENAI_API_KEY — the bot can't answer texts");; esac
case "$(get_env TWILIO_ACCOUNT_SID)" in ""|ACxxx*) missing+=("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN — only needed to buy a number or send SMS");; esac

if [ ${#missing[@]} -gt 0 ]; then
  echo
  warn "still using placeholder values in ${ENV_FILE}:"
  for item in "${missing[@]}"; do echo "    · ${item}"; done
fi

echo
echo "  env file       ${ENV_FILE}"
echo "  app            ${app_url}"
echo "  express        http://localhost:${APP_PORT}"
echo "  google redirect ${DIM}add this to your OAuth client:${OFF} ${app_url}/auth/google/callback"
echo
echo "  ${DIM}Inbound SMS needs a public URL: run 'ngrok http ${APP_PORT}', set APP_URL to the${OFF}"
echo "  ${DIM}ngrok https URL, re-add the redirect URI, and browse that URL instead.${OFF}"
echo "  ${DIM}To exercise the agent without Twilio at all: npm run simulate${OFF}"
echo

exec npm run dev:all
