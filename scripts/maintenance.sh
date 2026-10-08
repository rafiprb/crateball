#!/bin/sh
# Maintenance mode on the production server: new rooms, joins and match starts are refused and every
# open page shows the maintenance screen; matches already running finish. A restart (release) ends it.
#   sh scripts/maintenance.sh on|off|status
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)
FLAG=/tmp/crateball-maintenance
case "${1:-status}" in
  on) sh "$DIR/server.sh" "docker exec crateball-game-1 touch $FLAG" && echo "bakım modu açık" ;;
  off) sh "$DIR/server.sh" "docker exec crateball-game-1 rm -f $FLAG" && echo "bakım modu kapalı" ;;
  status) sh "$DIR/server.sh" "docker exec crateball-game-1 test -e $FLAG" && echo "açık" || echo "kapalı" ;;
  *) echo "kullanım: sh scripts/maintenance.sh on|off|status" >&2; exit 1 ;;
esac
