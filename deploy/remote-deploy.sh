#!/bin/sh
# Runs ON THE SERVER as /usr/local/bin/crateball-deploy (root-owned, installed only by
# scripts/install-deploy.sh, never from an upload). Reads a tar of the repo (git archive) on stdin and
# deploys it. Usage (over SSH): crateball-deploy deploy <version> [force]
# The GitHub Actions key may only run this script (authorized_keys "command=…,restrict").
#
# The upload is ONLY the build context of the game image. Everything that decides what runs on the host
# — this script, the Compose file, the Caddyfile and the Dockerfile — comes from root-owned files in
# /etc/crateball, so a stolen deploy key can at most ship a different game build into the same locked-
# down container, not change what is mounted, published or privileged.
# Without "force" it waits (up to 30 min) until no match is being played: a restart wipes rooms.
set -eu
CONF=/etc/crateball
SRC=/opt/crateball/src
STATE=/var/lib/crateball
COMPOSE="docker compose -f $CONF/compose.yml"
set -- ${SSH_ORIGINAL_COMMAND:-$*}
[ "${1:-}" = "deploy" ] || { echo "usage: deploy <version> [force]" >&2; exit 2; }
VERSION=$(printf '%s' "${2:-unknown}" | tr -cd 'A-Za-z0-9._-' | cut -c1-40)
FORCE=${3:-}
for f in compose.yml Caddyfile Dockerfile; do
  [ -f "$CONF/$f" ] || { echo "$CONF/$f missing: run scripts/install-deploy.sh first" >&2; exit 4; }
done

exec 9>/var/lock/crateball-deploy.lock
flock -n 9 || { echo "another deploy is running" >&2; exit 3; }

mkdir -p "$(dirname "$SRC")" "$STATE"
rm -rf "$SRC.new" && mkdir -p "$SRC.new"
tar -x -C "$SRC.new" --no-same-owner --no-same-permissions
# The fixed Dockerfile, not the uploaded one; the upload is the context only.
cp "$CONF/Dockerfile" "$SRC.new/.crateball.Dockerfile"

# Build first, while the old version keeps serving: the risky window (check → restart) is then seconds.
docker build -q -f "$SRC.new/.crateball.Dockerfile" --build-arg "APP_VERSION=$VERSION" -t crateball:next "$SRC.new"
rm -rf "$SRC.new"

if [ "$FORCE" != "force" ]; then
  # A restart wipes every room. Wait until no match is on, and also give people sitting in a lobby
  # (right after a match, say) up to LOBBY_WAIT seconds to leave before cutting them off.
  waited=0
  lobby_waited=0
  LOBBY_WAIT=600
  while :; do
    if $COMPOSE ps --status running -q game 2>/dev/null | grep -q .; then
      # Fail closed: if the running game does not answer, assume a match may be on and wait.
      health=$($COMPOSE exec -T game wget -qO- http://localhost:8080/health 2>/dev/null || true)
      playing=$(printf '%s' "$health" | sed -n 's/.*"playing":\([0-9]*\).*/\1/p')
      players=$(printf '%s' "$health" | sed -n 's/.*"players":\([0-9]*\).*/\1/p')
      playing=${playing:-unknown}
      players=${players:-unknown}
    else
      playing=0 # nothing running yet (first deploy, or it is down anyway)
      players=0
    fi
    if [ "$playing" = "0" ]; then
      [ "$players" = "0" ] && break
      [ "$lobby_waited" -ge "$LOBBY_WAIT" ] && { echo "still $players in lobbies after $LOBBY_WAIT s; deploying"; break; }
      echo "no match, but $players in lobbies — waiting…"
      lobby_waited=$((lobby_waited + 15))
    else
      echo "match(es) running: $playing — waiting…"
    fi
    [ "$waited" -ge 1800 ] && { echo "matches still running (or game not answering) after 30 min; deploy with force" >&2; exit 5; }
    sleep 15
    waited=$((waited + 15))
  done
fi

# Keep the running image under a second name: if the new one does not come up, we go back to it.
docker image tag crateball:latest crateball:previous 2>/dev/null || true
docker image tag crateball:next crateball:latest
APP_VERSION="$VERSION" $COMPOSE up -d --no-build --remove-orphans
# Caddy bind-mounts the fixed Caddyfile: a changed file (installed by install-deploy.sh) only takes
# effect in a new container, so it is recreated once per change.
sum=$(sha256sum "$CONF/Caddyfile" | cut -d' ' -f1)
if [ "$sum" != "$(cat "$STATE/caddyfile.sha256" 2>/dev/null || true)" ]; then
  APP_VERSION="$VERSION" $COMPOSE up -d --no-build --no-deps --force-recreate caddy
  echo "$sum" > "$STATE/caddyfile.sha256"
fi
for i in 1 2 3 4 5 6 7 8 9 10; do
  if out=$($COMPOSE exec -T game wget -qO- http://localhost:8080/health 2>/dev/null); then
    echo "$out"
    docker image rm crateball:next >/dev/null 2>&1 || true
    docker image prune -f >/dev/null
    echo "deployed $VERSION"
    exit 0
  fi
  sleep 2
done
echo "game did not become healthy: rolling back to the previous image" >&2
if docker image inspect crateball:previous >/dev/null 2>&1; then
  docker image tag crateball:previous crateball:latest
  APP_VERSION="rollback-$VERSION" $COMPOSE up -d --no-build --remove-orphans --force-recreate game || true
  echo "rolled back to crateball:previous" >&2
fi
exit 6
