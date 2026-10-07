#!/bin/sh
# Prod imajını kurar, çalıştırır ve kontrol eder. Docker CLI takılırsa Docker Desktop'ı yeniden başlat.
set -eu
IMAGE=crateball:local
PORT=8080
URL="http://localhost:$PORT"
fail() { echo "HATA: $*"; docker logs "$CID" 2>&1 | tail -40; exit 1; }

# Dizinin konteynerde olmadığını kanıtlar: grep 1 = yok (iyi), 0 = var (sızıntı), diğer = komut hatası.
assert_absent() {
  set +e
  docker exec "$CID" sh -c "grep -rqE '__game|/__log|createDevLogRoute' $1"
  rc=$?
  set -e
  [ "$rc" -eq 1 ] || fail "dev araçları $1 içinde (grep rc=$rc)"
}

docker build -t "$IMAGE" .
# The prod image only lets playcrateball.com open game sockets; this local run is on localhost.
CID=$(docker run -d --rm -p "$PORT:8080" -e CRATEBALL_ORIGINS="$URL" "$IMAGE")
trap 'docker stop "$CID" >/dev/null 2>&1 || true' EXIT

i=0
until curl -fsS --max-time 2 "$URL/health" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -le 30 ] || fail "/health 30 denemede cevap vermedi"
  sleep 1
done

curl -fsS --max-time 5 "$URL/" | grep -q '<title>Crateball</title>' || fail "ana sayfa yok"
code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' -X POST "$URL/__log" -d '[]')
[ "$code" = "404" ] || fail "prod'da /__log açık ($code)"
assert_absent dist/client
assert_absent dist/server

PROD_URL="$URL" pnpm exec playwright test --config playwright.prod.config.ts || fail "prod tarayıcı testi"

echo "docker smoke OK"
