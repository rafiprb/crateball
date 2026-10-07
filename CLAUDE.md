# Crateball

Tarayıcıda linkle açılan 3v3 arcade futbol: kutulardan silah/mayın/buz çıkar,
oyuncuların mevkileri var. Tamamen yapay zekâ ile geliştiriliyor.

- Tasarım ve ağ modeli: `docs/design.md` — her işten önce oku.
- Eski proje (Before Nightfall) git geçmişinde, `before-nightfall` etiketinde duruyor.

## Bu makinede kabuk

zsh profili `node/npm/npx/pnpm/corepack` adında kendini çağıran nvm fonksiyonları tanımlıyor. Her komutu şu önekle çalıştır:

```sh
unset -f node npm npx pnpm pnpx corepack 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH";
```

## Komutlar

| Komut | Ne yapar |
|---|---|
| `pnpm dev` | Sunucu (3000) + istemci (5173). Tarayıcı: `http://localhost:5173/?name=Y` (menü), `?name=Y&autoplay&debug` (oda kurup hemen başlatır), `/r/KOD?name=Z` (katıl) |
| `pnpm verify` | format + typecheck + lint + birim + e2e. **Bir iş bunu geçmeden bitmiş sayılmaz.** |
| `pnpm test` / `pnpm e2e` | Sadece Vitest / sadece Playwright |
| `pnpm netsim [sn] [tohum]` | Ağ ölçümü: gerçek sunucu odası + 4 tahminci, sanal saat ve modellenmiş bağlantılarla; top düzeltmesi, çizilen topun hatası, kuyruk tablosu (`tests/netsim`) |
| `pnpm build` | `dist/client` + `dist/server/server.mjs` |
| `pnpm docker:prod` | Prod imajını yerelde kurup smoke testini koşar (`docker smoke OK`) |
| `pnpm deploy` | (`.deploy.env` gerekir) Commit'lenmiş HEAD'i VPS'e gönderir, orada derler. Maç oynanıyorsa bekler; `pnpm deploy --force` beklemez (açık odalar silinir) |
| `pnpm logs` / `pnpm watch` | VPS'teki oyun logunu canlı izler / sadece önemli olayları süzer (`scripts/watch.mjs`) |

## Mimari kuralları (lint ile zorlanır)

- `packages/sim`: saf ve deterministik oyun (fizik, kutular, botlar, mevkiler). `Math.random`, `Date`, DOM, `ws`, `node:*`, diğer `@crateball/*` yasak. Rastgelelik durumdaki `rng` alanından (`nextRandom`), karşılaştırma `hashState`. Kutu ganimeti ayrı, gizli `lootRng`'den: sunucu her adımdan önce crypto ile yeniler, snapshot'a girmez (istemcide `null`: tahmin kutuyu açar, eşya sonraki snapshot'la gelir). Trig fonksiyonu kullanma (motorlar arası determinizm).
- `packages/protocol`: yalnızca `@crateball/sim` tiplerine bağlı. Ağdan gelen her şey `decode*` ile doğrulanır.
- `packages/server`: odalar (`rooms.ts`: kod, host, lobi/maç durumu, botlar, takas), 60 Hz tick, girdi kuyruğu, 30 Hz snapshot, `GET /rooms`. Render koduna bağlanamaz.
- `packages/client`: Canvas 2D (`render.ts`), tahmin/geri sarma (`predict.ts`), menü/lobi DOM (`ui.ts`), olay çıkarımı (`events.ts`) → ses (`sound.ts`) + parçacık (`particles.ts`), klavye (`input.ts`). Sunucuya bağlanamaz.
- `packages/devtools` yalnızca `import.meta.env.DEV` dalında yüklenir; prod paketine girmez.
- Oyun sabitleri yalnızca `packages/sim/src/content/rules.ts`; renkler `packages/client/src/render.ts` başında.

## Yayın (prod)

- Adres: **https://playcrateball.com** (GoDaddy DNS: A @ → VPS, CNAME www → @). Caddy HTTPS sertifikasını kendisi alır/yeniler.
- Sunucu: İstanbul VPS, `root`, yalnızca SSH anahtarıyla. Adres/port/anahtar yolu **`.deploy.env`** içinde (git'e girmez; örnek: `deploy/deploy.env.example`); yedeği ve açıklaması yerel backup klasöründe (`OKUBENI.txt`). Sunucuya komut: `sh scripts/server.sh '<komut>'`. ufw: yalnızca SSH portu, 80, 443. Güvenlik güncellemeleri otomatik.
- GitHub secret'ları: `DEPLOY_SSH_KEY` (sunucuda sadece `crateball-deploy` çalıştırabilen kısıtlı anahtar), `DEPLOY_KNOWN_HOSTS`, `DEPLOY_HOST`, `DEPLOY_PORT`.
- Sunucuda sabit, root'a ait dosyalar: `/etc/crateball/{compose.yml,Caddyfile,Dockerfile}` ve `/usr/local/bin/crateball-deploy` (`deploy/remote-deploy.sh`). Yayın (deploy anahtarı) bunları **değiştiremez**: yüklenen arşiv yalnızca oyun imajının derleme bağlamıdır (`/opt/crateball/src`), sabit Dockerfile ile derlenir. Bu dosyalardan biri (compose, Caddyfile, Dockerfile, deploy betiği) değişince: commit'le, sonra `sh scripts/install-deploy.sh` (dosyaları koyar; bir sonraki yayın uygular) ya da `sh scripts/install-deploy.sh apply` (hemen uygular; oyun konteyneri yeniden kurulursa açık odalar silinir). Oyun logu sunucunun journald'ına gider (yayınlardan sonra da kalır, toplam en fazla 500 MB): `journalctl -o cat CONTAINER_TAG=crateball-game`.
- Odalar bellekte: yeniden başlatma açık odaları siler. Tek süreç, tek makine olmalı.
- `/health`: `{ ok, version, rooms, playing, players }`.

## Debug akışı

- Dev: tüm loglar tek dosyada, `logs/dev.log` (sunucu + tarayıcı konsolu, `"src":"client"`).
- Prod telemetri: her istemci oyunda 2 sn'de bir `istemci istatistik` (fps, en uzun kare, ping, bekleyen girdi, kendi oyuncusunun düzeltmesi px) yollar; sunucu 5 sn'de bir `oda istatistik` (girdisiz tick, kuyruk, saat eşitleme `lead`'i, en yavaş tick) yazar. Oyuncu **R**'ye (ya da F9) basınca son ~10 sn `oyuncu raporu (R)` olarak loglanır. `pnpm watch` bunları süzer.
- `window.__game` (dev): `getState()` → `{ frame, screen, room, net(rtt), render(particles), pred(pending, corrections), sim(...) }`; `cmd('fx', 'mine'|'ice'|'goal'…)` efekt dener. F1: FPS, bağlantı+RTT, bekleyen girdi, düzeltme sayısı.
- Gecikme denemesi (yalnızca dev): URL'ye `&lag=100&jitter=20` ekle (tek yön ms; ping ≈ 2×lag). F1'de RTT/pending/corrections. Otomatik test: `tests/e2e/multiplayer.spec.ts` içindeki `withLatency`.
- Determinizm: aynı seed + aynı girdi → aynı `hashState`; şüphede `packages/sim/test/game.test.ts`.

## Kurallar

- Oyuncunun gördüğü her metin **İngilizce**. Fontlar Baloo 2 + Nunito.
- Kod tanımlayıcıları İngilizce; log mesajları Türkçe olabilir.
- Commit mesajları sade İngilizce, kanban id yok (kişisel proje).
- Docker CLI takılırsa: `osascript -e 'quit app "Docker"'; open -a Docker`. Hiçbir şeyi silme/prune etme.
