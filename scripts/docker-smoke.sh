#!/bin/sh
# Prod imajını kurar, çalıştırır ve kontrol eder. Docker CLI takılırsa Docker Desktop'ı yeniden başlat.
#   sh scripts/docker-smoke.sh         # yalnızca oyun konteyneri (http://localhost:8080)
#   sh scripts/docker-smoke.sh stack   # sunucudaki sertleştirilmiş compose yığını: Caddy (localhost, kendi
#                                      # sertifikası), CSP/HSTS başlıkları, salt okunur ve yetkisiz konteynerler
set -eu
fail() { echo "HATA: $*"; [ -n "${CID:-}" ] && docker logs "$CID" 2>&1 | tail -40; exit 1; }

# Dizinin konteynerde olmadığını kanıtlar: grep 1 = yok (iyi), 0 = var (sızıntı), diğer = komut hatası.
assert_absent() {
  set +e
  docker exec "$CID" sh -c "grep -rqE '__game|/__log|createDevLogRoute' $1"
  rc=$?
  set -e
  [ "$rc" -eq 1 ] || fail "dev araçları $1 içinde (grep rc=$rc)"
}
wait_health() {
  i=0
  until curl -fsSk --max-time 2 "$1/health" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -le 60 ] || fail "/health 60 denemede cevap vermedi"
    sleep 1
  done
}

if [ "${1:-}" = "stack" ]; then
  export CRATEBALL_SITE=localhost CRATEBALL_HTTP_PORT=18081 CRATEBALL_HTTPS_PORT=18443 CRATEBALL_LOG_DRIVER=json-file
  URL="https://localhost:$CRATEBALL_HTTPS_PORT"
  export CRATEBALL_ORIGINS="$URL"
  STACK="docker compose -f deploy/compose.yml -p crateball-smoke"
  docker build -f Dockerfile -t crateball:latest .
  trap '$STACK down -v >/dev/null 2>&1 || true' EXIT
  $STACK up -d
  CID=$($STACK ps -q game)
  wait_health "$URL"
  headers=$(curl -fsSkI "$URL/")
  for h in "content-security-policy: .*frame-ancestors 'none'" "strict-transport-security: max-age" \
    "x-content-type-options: nosniff" "referrer-policy:"; do
    printf '%s' "$headers" | grep -qi "$h" || fail "başlık yok: $h"
  done
  for svc in game caddy; do
    c=$($STACK ps -q "$svc")
    [ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$c")" = "true" ] || fail "$svc salt okunur değil"
    docker inspect -f '{{.HostConfig.CapDrop}}' "$c" | grep -q ALL || fail "$svc yetkileri düşmemiş"
    docker inspect -f '{{.HostConfig.SecurityOpt}}' "$c" | grep -q no-new-privileges || fail "$svc no-new-privileges yok"
  done
  [ "$(docker exec "$CID" id -u)" != "0" ] || fail "oyun root olarak çalışıyor"
  assert_absent dist/client
  assert_absent dist/server
  PROD_URL="$URL" pnpm exec playwright test --config playwright.prod.config.ts || fail "prod tarayıcı testi"
  echo "docker stack smoke OK"
  exit 0
fi

IMAGE=crateball:local
PORT=8080
URL="http://localhost:$PORT"
docker build -t "$IMAGE" .
# The prod image only lets playcrateball.com open game sockets; this local run is on localhost.
CID=$(docker run -d --rm -p "$PORT:8080" -e CRATEBALL_ORIGINS="$URL" "$IMAGE")
trap 'docker stop "$CID" >/dev/null 2>&1 || true' EXIT
wait_health "$URL"
curl -fsS --max-time 5 "$URL/" | grep -q '<title>Crateball</title>' || fail "ana sayfa yok"
code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' -X POST "$URL/__log" -d '[]')
[ "$code" = "404" ] || fail "prod'da /__log açık ($code)"
assert_absent dist/client
assert_absent dist/server

PROD_URL="$URL" pnpm exec playwright test --config playwright.prod.config.ts || fail "prod tarayıcı testi"

echo "docker smoke OK"
