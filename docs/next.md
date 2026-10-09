# Next up

Work agreed but not started (or not finished). Newest decisions first in each section.

## In progress

Nothing right now.

## Load test

Measure before deciding anything about capacity (no scaling work without numbers and an explicit OK).

- **Tool:** `pnpm loadtest --url wss://playcrateball.com/ws --players 60 --seconds 300` (tests/load/run.ts).
  Clients named `load-…` in private rooms called `load`; they chase the ball and kick. One machine runs
  at most 96 (the per-address connection limit). The server writes a `sunucu istatistik` line every 5 s
  (tick time, event loop delay, CPU, memory, traffic); read it in Grafana Logs.
- **Local baseline (laptop, no TLS, 2026-10-08):** 90 players / 15 rooms: server CPU 31% of one core,
  tick 2.3 ms average (7 ms max) of the 16.7 ms budget, ~900 kbit/s per player (82 Mbit/s out), no
  snapshot gaps. Prod numbers still to measure.
- Steps of 20, 50, 100, 200 players; run against prod at a quiet hour.
- Generate load from more than one place: the laptop's own downlink fills first (about 1 Mbit/s per
  client today). Clients on the server itself measure CPU without the network; combine both.
- Watch it in Grafana: per-core CPU, network, tick time, rooms and players. Add proper game metrics for
  it (tick time, bytes sent, rooms, players) instead of the 5 s log lines.
- **Prod, one process, JSON snapshots (2026-10-08, from the office):** 24 players fine; 48 players: game
  process 66-77% of a core, slowest tick 15-24 ms (budget 16.7), Caddy ~1.1 cores; 72 players: ticks
  30-40 ms, everyone lags. The office downlink (~67 Mbit/s) capped the 90 step. Since then: binary
  snapshots and 3 processes (see Capacity); measure again.

## Launch readiness

- **Server picker + gate at the door** (agreed 2026-10-08, after the load test; prototype at scratchpad
  `servers.html`). Each game process shows as a server ("Istanbul 1-3"; stable names, not renumbered if
  the count changes). Menu: an optional picker, "Auto" (emptiest) by default, each server with a fill bar
  and ping. Find Room lists every server's rooms with a server tag (a small player base must not feel
  split); invite links and room codes still pick the server by themselves.
  - Capacity unit becomes "connected people", menu included, counted once at the coordinator (the only
    door): leaving a room never loses your seat, and there is no "the total has room but this worker is
    full" case for people browsing. Idle in the menu for ~10 min: back to the queue.
  - Two limits: the door (total, from the load test) and per worker what one core carries (also from the
    load test, above an even share, e.g. door 150, worker 70). A worker at its limit refusing a join is
    correct: it would lag everyone there. A refused create reconnects to a server with room.
  - Queue per server ("Istanbul 2 is full: 4th in line; Istanbul 3 has room, switch?"), and one shared
    line when every server is full. Later regions fit the same screen (Istanbul, Frankfurt).
- **Admission queue when the server is full.** Lives wherever the caps are counted (the server today,
  the coordinator later). A full room (6/6) is not this: that stays spectate-then-take-a-seat.
  - Two thresholds: up to 90% everyone gets in; from 90% new rooms and quick play queue while joins
    into an existing room with a free seat (invites) still go straight in; at 100% everyone queues,
    invites first, but every third free slot goes to the regular queue so nobody waits forever.
  - The client shows its place and an estimated wait (slots free up mostly when matches end, so the
    estimate comes from matches about to finish).
  - A dropped connection keeps its place for 30 s. If an invited player's room closes or fills while
    they wait, they move to the regular queue and are told why.
  - No per-IP limits (offices share one IP). The queue itself is capped (for example 1000); beyond
    that the client says to try again later. Lobby browsers and spectators count against the socket
    cap, not players; keep the socket cap above the player cap so the queue can connect.
- **Grafana alerts:** live since 2026-10-09, to Telegram (@crateballbot): server full and at 80% of the
  player cap, slowest tick above 10 ms, a game process crashing, an error burst, no data from the server
  for 5 min, CPU, memory and disk, the site unreachable from outside. `scripts/alerts.mjs`. The last one
  needs its Synthetic Monitoring check made in the Grafana UI (HTTP, job `crateball-health`, /health);
  "no data from the server" also fires if only the monitoring agent stops.

## Capacity

Done on 2026-10-08 (load test on prod showed the single game process topping out around 50-60 players on
the production CPU, and Caddy spending a core on TLS at 48 players):

1. **Caps from env** (`CRATEBALL_MAX_ROOMS/PLAYERS/SOCKETS`) and a "servers are full" screen that retries.
2. **Binary delta snapshots** (protocol 13): ~3.3 KB → ~210 B per snapshot, ~800 → ~50 kbit/s per player.
   No quantisation beyond the 1/1000 rounding the JSON snapshots already had (prediction stays exact).
3. **Several game processes** (3 in production): the coordinator hands each socket to the worker that
   holds its room; caps, /health and /rooms add the workers up.

Load test after these (prod, from the office laptop): 48 players → busiest process 39% (was 77%), ping
p95 45 ms; 72 players → each process ~50% of a core, ping p95 65 ms, no drops (the old build fell apart
here). Caps set to 90 people / 24 rooms / 300 sockets.

Slow ticks (average 5 ms, worst 20-40 ms) were not GC (2-5% of the time) but the machine filling up: at
120 players Caddy took 1.3-1.5 cores and network interrupts ~30%, because every WebSocket message costs
TLS and a proxy copy (~12,000 messages/s at 120 players; bytes are small now). Caddy → game over a Unix
socket cut interrupts (22% → 16.5% at 72 players, ping p95 70 → 52 ms); Caddy stays the biggest consumer.
Batching two ticks of input per message was measured in netsim (`pnpm netsim 300 6 --batch 2`) and
rejected: own-player correction p95 up to 2x on some links. Verdict: this machine carries ~90-100 players
well; beyond that, add machines (the server picker below spans them) or a bigger one
(`CRATEBALL_WORKERS`, caps). Maybe: a lighter TLS terminator than Caddy for /ws (HAProxy), measured
first.

**Several servers** (later, if one machine is not enough): the same split across machines, the room list
in the coordinator or Redis, clients connecting straight to the room's server; also allows regions.

Rewriting the backend in Go is not planned: the sim would exist twice (TS client prediction + Go server)
and any difference shows up as constant corrections.

## Goal replays

Live since 2026-10-09 (protocol 18); how it works is in docs/design.md ("Gol tekrarları"). Decided on
2026-10-09: only goals are kept, never whole matches; nothing on the server's disk (no purge, no cheat
review for now). Players keep their last 10 matches in the browser and download `.crateball` files that open
only in the game.

- The Steam builds need a new upload for double-click to work there (Desktop workflow artifacts; the upload
  is the owner's).
- Later, if needed: server-side recording for cheat reports or for tuning the scoring on real matches (the
  same clip format covers a whole match).

## Scoring (MVP)

Live since 2026-10-09 (protocol 17, PR #2's results screen kept); the rules as built are in docs/design.md ("Maç sonu ekranı"). Decided on
2026-10-08: a rebound off the post keeps the assist chain; any opponent contact breaks it. Weights looked
at over 60 bot matches; tune them again from how real matches feel (no recordings), especially assists and
defence, which bots barely produce.

## Gameplay and UI

- **Arena goal effects and balls** (prototype `arenas.html`): per-arena goal effects and sounds first;
  arena balls cosmetic only, with a "standard ball" option, tried in real matches before deciding
  (volcano ball is the least readable). Could later be cosmetics/DLC.
- **Server-enforced minimum kick interval** against macro scripts: only if it does not change the feel.

## Steam

- Trailer: upload `crateball-trailer.mp4` on the store page (Trailers), set it first.
- Set the main build live when the store page is approved.
- Supporter pack / DLC: see the prototype; Steam ownership check later.
