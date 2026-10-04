#!/bin/sh
# Runs ON THE SERVER. Reads a tar of the repo (git archive) on stdin and deploys it.
# Usage (over SSH): crateball-deploy deploy <version> [force]
# The GitHub Actions key may only run this script (authorized_keys "command=…,restrict").
# Without "force" it waits (up to 30 min) until no match is being played: a restart wipes rooms.
set -eu
DIR=/opt/crateball
set -- ${SSH_ORIGINAL_COMMAND:-$*}
[ "${1:-}" = "deploy" ] || { echo "usage: deploy <version> [force]" >&2; exit 2; }
VERSION=$(printf '%s' "${2:-unknown}" | tr -cd 'A-Za-z0-9._-' | cut -c1-40)
FORCE=${3:-}

exec 9>/var/lock/crateball-deploy.lock
flock -n 9 || { echo "another deploy is running" >&2; exit 3; }

rm -rf "$DIR.new" && mkdir -p "$DIR.new"
tar -x -C "$DIR.new"
[ -f "$DIR.new/deploy/compose.yml" ] || { echo "archive has no deploy/compose.yml" >&2; exit 4; }

# Build first, while the old version keeps serving: the risky window (check → restart) is then seconds.
(cd "$DIR.new/deploy" && APP_VERSION="$VERSION" docker compose build game)

if [ "$FORCE" != "force" ]; then
  waited=0
  while :; do
    if docker compose -f "$DIR/deploy/compose.yml" ps --status running -q game 2>/dev/null | grep -q .; then
      # Fail closed: if the running game does not answer, assume a match may be on and wait.
      playing=$(docker compose -f "$DIR/deploy/compose.yml" exec -T game wget -qO- http://localhost:8080/health 2>/dev/null \
        | sed -n 's/.*"playing":\([0-9]*\).*/\1/p')
      playing=${playing:-unknown}
    else
      playing=0 # nothing running yet (first deploy, or it is down anyway)
    fi
    [ "$playing" = "0" ] && break
    [ "$waited" -ge 1800 ] && { echo "matches still running (or game not answering) after 30 min; deploy with force" >&2; rm -rf "$DIR.new"; exit 5; }
    echo "match(es) running: $playing — waiting…"
    sleep 15
    waited=$((waited + 15))
  done
fi

rm -rf "$DIR.old"
[ -d "$DIR" ] && mv "$DIR" "$DIR.old"
mv "$DIR.new" "$DIR"
cd "$DIR/deploy"
APP_VERSION="$VERSION" docker compose up -d --no-build --remove-orphans
# Caddy mounts the Caddyfile from the release directory that was just swapped: a changed file only
# takes effect in a new container.
if [ -f "$DIR.old/deploy/Caddyfile" ] && ! cmp -s "$DIR/deploy/Caddyfile" "$DIR.old/deploy/Caddyfile"; then
  APP_VERSION="$VERSION" docker compose up -d --no-build --no-deps --force-recreate caddy
fi
docker image prune -f >/dev/null
install -m 0755 "$DIR/deploy/remote-deploy.sh" /usr/local/bin/crateball-deploy
for i in 1 2 3 4 5 6 7 8 9 10; do
  if out=$(docker compose exec -T game wget -qO- http://localhost:8080/health 2>/dev/null); then
    echo "$out"
    echo "deployed $VERSION"
    exit 0
  fi
  sleep 2
done
echo "game did not become healthy" >&2
exit 6
