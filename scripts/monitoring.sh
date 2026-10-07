#!/bin/sh
# Installs or updates the monitoring agent (deploy/monitoring) on the production server, next to the
# game in /opt/crateball-monitoring. Grafana Cloud details come from .grafana.env (gitignored; see
# deploy/monitoring/grafana.env.example). Usage: sh scripts/monitoring.sh [logs]
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$ROOT/.grafana.env" ] || { echo ".grafana.env yok: deploy/monitoring/grafana.env.example dosyasını kopyalayıp doldur" >&2; exit 1; }
S="sh $ROOT/scripts/server.sh"
if [ "${1:-}" = "logs" ]; then
  exec $S 'cd /opt/crateball-monitoring && docker compose logs --tail 80 alloy'
fi
$S 'mkdir -p /opt/crateball-monitoring && chmod 700 /opt/crateball-monitoring'
for f in compose.yml config.alloy; do
  $S "cat > /opt/crateball-monitoring/$f" < "$ROOT/deploy/monitoring/$f"
done
$S 'umask 077 && cat > /opt/crateball-monitoring/grafana.env' < "$ROOT/.grafana.env"
$S 'cd /opt/crateball-monitoring && docker compose pull -q && docker compose up -d && sleep 8 && docker compose ps'
