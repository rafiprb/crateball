# Next up

Work agreed but not started (or not finished). Newest decisions first in each section.

## In progress

- **PR #2, match stats and results screen** (external contributor). Review sent back with the bugs found
  (touches in a scramble, saves, Enter opening the lobby chat) and the scoring spec below. The netcode branch
  has landed, so `PROTOCOL_VERSION` becomes 13 by hand (git will not show it as a conflict).

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

- **Caps from the load test.** Configurable by env now; set the defaults just under the measured capacity.
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
- **Grafana alerts** (Alerting, contact point chosen by the owner: Telegram, Discord/Slack or e-mail):
  players above 80% of the cap, server not answering for 2 min, slowest tick above 10 ms, disk or
  memory nearly full. Shipped as an importable file like the dashboard.

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

## Match recording and replays

- Record every match: seed, settings, the server-only loot RNG seed and each player's input per tick
  (about 360 B/s for 6 players; a few KB per match compressed). Keep 30 days on disk.
- Uses: backtest the scoring on real matches, goal replays / clips with the game's own renderer (as in
  the trailer), looking into cheating reports, debugging R reports.
- After the netcode branch lands (it touches the same server files).

## Scoring (MVP) spec

Built to resist farming: count outcomes, not intent; a scramble produces nothing; goals and assists
decide the MVP.

- **Possession.** A player owns the ball after touching it if nobody else touches it within 0.5 s.
  Touches alternating between teams faster than that make the ball *loose*: no shots, passes or
  tackles are counted until a team owns it again (0.5 s alone, or a kick that travels 1.5 s untouched).
- **Shot on target.** A kick (not a contact), by an owner or a clean strike on a loose ball, from the
  opponent half, above a minimum speed, whose outcome is a goal, a keeper save or a defender's block in
  the box. Wide/post/out = off target (shown, not scored). One per possession.
- **Save (keeper only).** Stops a shot on target; no goal within 2 s; one per shot.
- **Assist.** The scorer's dribble counts as one spell; the touch before its first touch must be a
  teammate's, at most 3 s earlier, with no opponent touch in between. Walls, mines, lava and wind do not
  break the chain. Only the last passer counts. No assist on own goals or straight from kickoff. Open:
  rebound off the post counts (proposed yes); any opponent contact breaks the chain (proposed yes).
- **Completed pass (midfield).** From possession, reaches a teammate after at least 80 px with no
  opponent touch; the same pair counts once per 10 s.
- **Tackle (defence).** The opponent owned the ball for 0.5 s or more, then your side owns it for 0.5 s.
- **Block (defence).** Stops a shot on target in the box before the keeper.
- **Points.**

  | Role | Goal | Assist | Role extras (capped at 3 points) |
  |---|---|---|---|
  | Forward | 3 | 2 | shot on target 0.5 |
  | Midfield | 2 | 3 | completed pass 0.25 |
  | Defence | 2 | 2 | tackle 0.5, block 1 |
  | Keeper | 2 | 2 | save 1, clean sheet +2; goal conceded −0.5 (outside the cap) |
  | No role | 3 | 2 | none |

  Own goal −1. Deaths, damage and crates are shown but never scored. Ties: winning side, then goals,
  then assists. Roles off: everyone scores as "no role". Nothing counts during kickoff, the goal pause
  or after the whistle. Stats stay write-only (the sim never reads them).
- Tests for every rule, including the farming cases: two players kicking it back and forth in front of
  goal for 10 s (0 shots, 0 tackles), teammates rubbing passes side by side (0 passes), a roll toward
  goal from your own half (no shot), a keeper fumbling and catching again (1 save).
- Tune the weights on recorded matches (see above) so a good player in any role has a similar chance.

## Gameplay and UI

- **Kickoff countdown.** The kicking team has 5 s, then the ball is live for everyone; nothing shows
  this. Draw a shrinking ring around the centre circle with "BLUE KICKS OFF", then "BALL IS LIVE".
  Maybe shorten to 3 s.
- **Beach arena** (prototype at scratchpad `beach.html`): umbrellas outside the pitch, a water zone
  (slower, floatier, rings around swimmers), rubber ducks that quack and shed feathers when hit (on-screen text "quack", a hard hit "QUACK!"). Ducks
  would be sim entities (deterministic, in snapshots). Owner's notes on the prototype:
  - Make the water zone bigger (the side bays reach further into the pitch), still symmetric, with the
    goal mouths and the kickoff circle kept dry.
  - Ducks bumping into each other make no sound and no feathers; only the ball or a player hitting a
    duck quacks.
  - Water is a look, not a mechanic: players and the ball move exactly as on dry ground (no slowdown,
    no glide, no current). In the water a player wears a ring and sways side to side while dipping in
    and out; the ball turns into a beach ball. Ducks are still sim entities (they block the ball).
  - Pitch lines look scratched into the sand (wobbly, broken, scuffed); no lines or markers in the water.
  - A player running hard into a duck also sheds feathers (a lower hard-hit threshold for players than
    for the ball, since players move slower than shots).
  - Cost estimate from the prototype: about +3.5 KB gzipped, 4 ducks add about 380 B per snapshot
    (about 13% of today's snapshot).
- **Arena goal effects and balls** (prototype `arenas.html`): per-arena goal effects and sounds first;
  arena balls cosmetic only, with a "standard ball" option, tried in real matches before deciding
  (volcano ball is the least readable). Could later be cosmetics/DLC.
- **Server-enforced minimum kick interval** against macro scripts: only if it does not change the feel.

## Steam

- Trailer: upload `crateball-trailer.mp4` on the store page (Trailers), set it first.
- Set the main build live when the store page is approved.
- Supporter pack / DLC: see the prototype; Steam ownership check later.
