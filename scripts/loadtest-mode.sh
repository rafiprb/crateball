#!/bin/sh
# Load test mode on the production server: the server-wide caps and the per-address limits are lifted so
# one machine can run past them (pnpm loadtest). Ends by itself 30 minutes after "on"; a restart ends it.
#   sh scripts/loadtest-mode.sh on|off|status
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)
FLAG=/tmp/crateball-loadtest
case "${1:-status}" in
  on) sh "$DIR/server.sh" "docker exec crateball-game-1 touch $FLAG" && echo "yük testi modu açık (en fazla 30 dk)" ;;
  off) sh "$DIR/server.sh" "docker exec crateball-game-1 rm -f $FLAG" && echo "yük testi modu kapalı" ;;
  status) sh "$DIR/server.sh" "docker exec crateball-game-1 find $FLAG -mmin -30" | grep -q . && echo "açık" || echo "kapalı" ;;
  *) echo "kullanım: sh scripts/loadtest-mode.sh on|off|status" >&2; exit 1 ;;
esac
