#!/usr/bin/env bash
# Creates the production .env with every secret generated for you.
#
#   ./deploy/setup.sh hxgconnect.com you@hxgconnect.com
#
# Run once, on the server, from the project folder. It never overwrites an
# existing .env: the secrets in it protect data that is already encrypted.
set -euo pipefail

DOMAIN="${1:-}"; EMAIL="${2:-}"
OUT="${ENV_FILE:-.env}"

if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
  echo "Usage: ./deploy/setup.sh hxgconnect.com you@hxgconnect.com"; exit 1
fi
DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed -e 's#^https\?://##' -e 's#/.*$##' -e 's#^www\.##')"
if ! printf '%s' "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'; then
  echo "\"$DOMAIN\" doesn't look like a domain. Use the bare name, e.g. hxgconnect.com"; exit 1
fi
if ! printf '%s' "$EMAIL" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; then
  echo "\"$EMAIL\" doesn't look like an email address."; exit 1
fi
if [ -e "$OUT" ]; then
  echo "$OUT already exists. Leaving it alone: replacing its secrets would lock you out of saved integration keys."
  echo "To start over on a server with no data yet, delete it first: rm $OUT"; exit 1
fi
command -v openssl >/dev/null || { echo "openssl is needed: apt install -y openssl"; exit 1; }

secret() { openssl rand -base64 48 | tr -d '\n'; }
urlsafe() { openssl rand -hex 24; }                       # goes inside a URL: letters and digits only
ADMIN_PW="$(openssl rand -base64 18 | tr -d '\n/+=' | cut -c1-20)"

umask 077
cat > "$OUT" <<EOF
# HXG Connect production settings, generated $(date -u +%Y-%m-%d) by deploy/setup.sh.
# SAVE A COPY IN YOUR PASSWORD MANAGER. If ENCRYPTION_KEY is lost, every client
# has to re-enter their integration keys.

BASE_DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL

POSTGRES_PASSWORD=$(urlsafe)
DATABASE_APP_URL=postgres://hxg_app:$(urlsafe)@db:5432/hxg_connect
DATABASE_PLATFORM_URL=postgres://hxg_platform:$(urlsafe)@db:5432/hxg_connect

PLATFORM_JWT_SECRET=$(secret)
TENANT_JWT_SECRET=$(secret)
FILE_SIGNING_SECRET=$(secret)
ENCRYPTION_KEY=$(secret)

# First sign-in only. After you sign in and change the password in the
# console, delete the SUPER_ADMIN_PASSWORD line.
SUPER_ADMIN_EMAIL=$EMAIL
SUPER_ADMIN_PASSWORD=$ADMIN_PW

RATE_LIMIT_PER_MIN=600
BILLING_SCHEDULER=on

# Property portal emails (optional, see DEPLOY.md). Leave the domain empty until
# the MX record for it exists.
INBOUND_EMAIL_DOMAIN=
INBOUND_EMAIL_SECRET=$(urlsafe)
EOF
chmod 600 "$OUT"

# Only matters if the web app is hosted on Vercel (DEPLOY-SUPABASE-VERCEL.md).
VJ="apps/web/vercel.json"
if [ -f "$VJ" ] && [ "$DOMAIN" != "hxgconnect.com" ]; then sed -i "s/api\\.hxgconnect\\.com/api.$DOMAIN/g" "$VJ"; fi

cat <<EOF

Created $OUT for $DOMAIN.

  Console:        https://admin.$DOMAIN
  Sign in as:     $EMAIL
  First password: $ADMIN_PW

Next:
  1. Copy $OUT into your password manager now.
  2. docker compose -f docker-compose.prod.yml up -d --build
  3. Sign in, press Password in the sidebar and set your own, then delete
     the SUPER_ADMIN_PASSWORD line from $OUT.
EOF
