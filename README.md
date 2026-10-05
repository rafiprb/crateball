# Crateball

**Play:** https://playcrateball.com

Browser 3v3 arcade football. Open a link, create a room, share the code. Crates
drop at random spots: a **gun** (3 hits and you're out), a **mine** (lose a heart and slow down), **ice**
(frozen for a moment), plus speed, a shield and a power kick.

- **Positions:** GK, DF, MF and FW each get a buff only inside their own zone, so the team spreads out
  instead of everyone chasing the ball.
- **Pass assist:** a kick close to a teammate's direction bends toward their run (wider cone for
  midfielders); the arrow next to the ball shows where your kick will go.
- **Rooms:** 4-letter codes, `/r/CODE` links, public room list, a host who picks the settings, starts the
  match and can drag players between teams. Bots fill empty spots.
- **Netcode:** the server runs the match at 60 Hz and sends 30 Hz snapshots. Every client predicts the
  whole world, ball included, then rolls back and replays on each snapshot, so your own kick shows up
  immediately even at 100+ ms ping.

## Controls

| Key | Action |
| --- | --- |
| WASD / arrows | Move |
| Space / X | Kick |
| E / Shift | Shoot (with a gun) |
| T | Switch team |
| 1–4 | Position: GK, DF, MF, FW |
| M | Mute |
| R | Report a glitch (logs the last ~10 s of netcode stats) |

## Run it

Node 24 and pnpm.

```sh
pnpm install
pnpm dev        # http://localhost:5173
pnpm verify     # format, types, lint, unit and browser tests
pnpm docker:prod
pnpm deploy     # ship the committed code to the server (waits for running matches)
```

Add `?lag=100&jitter=30` to the URL in dev to simulate a slow connection. Design and netcode notes
(Turkish) are in [`docs/design.md`](docs/design.md).

The previous project in this repo, Before Nightfall, is kept at the `before-nightfall` tag.
