#!/bin/sh
# Sets up a fresh production server (deploy/provision-remote.sh does the work there; see deploy/README.md).
# Connection details come from .deploy.env (gitignored), like every other server script.
#   sh scripts/provision.sh start [deploy_key.pub]   # first run: still over port 22
#   sh scripts/provision.sh finish                   # once SSH on CRATEBALL_SSH_PORT works: close 22
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$ROOT/.deploy.env" ] || { echo ".deploy.env yok: deploy/deploy.env.example dosyasını kopyalayıp doldur" >&2; exit 1; }
. "$ROOT/.deploy.env"
PHASE=${1:-start}
PUB=/dev/null
case "$PHASE" in
  start)
    # A fresh machine still listens on 22; the script adds CRATEBALL_SSH_PORT (both stay open until finish).
    PORT=22
    if [ -n "${2:-}" ]; then
      [ -f "$2" ] || { echo "deploy anahtarı bulunamadı: $2" >&2; exit 1; }
      PUB=$2
    fi
    ;;
  finish) PORT=$CRATEBALL_SSH_PORT ;;
  *)
    echo "kullanım: sh scripts/provision.sh start [deploy_key.pub] | finish" >&2
    exit 1
    ;;
esac
# The remote script travels inside the command; the deploy key (public half) on stdin.
REMOTE=$(cat "$ROOT/deploy/provision-remote.sh")
exec ssh -p "$PORT" -i "$CRATEBALL_SSH_KEY" -o BatchMode=yes "$CRATEBALL_HOST" \
  "t=\$(mktemp) && cat > \"\$t\" <<'PROVISION_EOF'
$REMOTE
PROVISION_EOF
sh \"\$t\" $CRATEBALL_SSH_PORT $PHASE; rc=\$?; rm -f \"\$t\"; exit \$rc" < "$PUB"
