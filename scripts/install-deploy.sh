#!/bin/sh
# One-time setup (and every later change to the server-side deploy files): installs, root-owned,
#   deploy/remote-deploy.sh → /usr/local/bin/crateball-deploy
#   deploy/compose.yml, deploy/Caddyfile, Dockerfile → /etc/crateball/
# Releases (pnpm deploy, the GitHub Release workflow) never touch these: an uploaded release is only the
# build context of the game image. Run from a reviewed, committed checkout:
#   sh scripts/install-deploy.sh          # install the files (no restart)
#   sh scripts/install-deploy.sh apply    # also apply compose/Caddyfile now (recreates changed
#                                         # containers: restarting the game wipes open rooms)
# Without "apply", the next release applies them (it runs compose up and recreates Caddy if the
# Caddyfile changed).
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
S="sh $ROOT/scripts/server.sh"
[ -z "$(git -C "$ROOT" status --porcelain -- deploy Dockerfile scripts/install-deploy.sh)" ] ||
  { echo "deploy dosyalarında commit'lenmemiş değişiklik var; önce commit'le" >&2; exit 1; }
put() { # local file, remote path, mode
  $S "umask 022 && t=\$(mktemp) && cat > \"\$t\" && install -o root -g root -m $3 \"\$t\" $2 && rm -f \"\$t\"" < "$ROOT/$1"
}
$S 'install -d -o root -g root -m 0755 /etc/crateball /var/lib/crateball /opt/crateball'
put deploy/remote-deploy.sh /usr/local/bin/crateball-deploy 0755
put deploy/compose.yml /etc/crateball/compose.yml 0644
put deploy/Caddyfile /etc/crateball/Caddyfile 0644
put Dockerfile /etc/crateball/Dockerfile 0644
echo "✓ kuruldu: /usr/local/bin/crateball-deploy, /etc/crateball/{compose.yml,Caddyfile,Dockerfile}"
if [ "${1:-}" = "apply" ]; then
  $S 'cd /etc/crateball && docker compose up -d --no-build --remove-orphans &&
      docker compose up -d --no-build --no-deps --force-recreate caddy &&
      sha256sum Caddyfile | cut -d" " -f1 > /var/lib/crateball/caddyfile.sha256 && docker compose ps'
fi
