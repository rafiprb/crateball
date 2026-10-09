// Store screenshots (dev only): scripts/shots.mjs opens this page and photographs it. A real bot match is
// played headless to the final whistle with the server's own replay recorder running, then the game's own
// results screen and goals popup are put up over the final frame, as a player sees them. The bots get
// player names (the match itself is theirs, as in the trailer).
import '../style.css';
import { decodeReplays, type ReplayBundle } from '@crateball/protocol';
import {
  BOT,
  DEFAULT_SETTINGS,
  addPlayer,
  createGame,
  newArenaPlan,
  restartMatch,
  step,
  type ArenaKind,
  type Game,
} from '@crateball/sim';
import { createRecorder } from '../../../server/src/replays';
import { createGoals } from '../goals';
import { createParticles } from '../particles';
import type { Predictor } from '../predict';
import { createRenderer } from '../render';
import { createResults } from '../results';
import { createSound } from '../sound';

declare global {
  interface Window {
    shots: Record<string, unknown>;
  }
}

BOT.accelMul = 1;

const NAMES = {
  red: ['Lukas', 'Mateo', 'Chloe'],
  blue: ['Yuki', 'Oliver', 'Sofia'],
} as const;

export interface MatchSpec {
  seed: number;
  arenas: ArenaKind[];
  scoreLimit: number;
  minutes: number;
}

/** A whole bot match, recorded as the server records it. */
function playMatch(spec: MatchSpec): { g: Game; bundle: ReplayBundle; bytes: Uint8Array } {
  const g = createGame(spec.seed, {
    ...DEFAULT_SETTINGS,
    minutes: spec.minutes,
    scoreLimit: spec.scoreLimit,
    arenas: spec.arenas,
  });
  for (const team of ['red', 'blue'] as const)
    NAMES[team].forEach((name, i) => addPlayer(g, `${team}-${i}`, name, team, true));
  newArenaPlan(g);
  restartMatch(g);
  const rec = createRecorder();
  // The loot draws are the server's secret; here a fixed sequence keeps the match the same every run.
  let lootSeed = spec.seed * 7919;
  const none = new Map<string, number>();
  while (g.phase !== 'over' && g.tick < 60 * 60 * 20) {
    lootSeed = (Math.imul(lootSeed, 1664525) + 1013904223) >>> 0;
    g.lootRng = lootSeed;
    rec.before(g, none);
    step(g, none);
    rec.after(g, lootSeed);
  }
  const bytes = rec.bundle(g, Date.UTC(2026, 9, 9, 18, 40))!;
  // The bundle is decoded the way the client gets it (the popup plays it exactly as in the game).
  return { g, bytes, bundle: decode(bytes) };
}

function decode(bytes: Uint8Array): ReplayBundle {
  const d = decodeReplays(bytes);
  if (!d.ok) throw new Error(`replay ${d.why}`);
  return d.bundle;
}

/** The match's last frame behind the screens. */
function backdrop(g: Game) {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
  const renderer = createRenderer(canvas);
  renderer.resize(innerWidth, innerHeight, devicePixelRatio);
  const pos = (id: string) => {
    if (id === 'ball') return { x: g.ball.x, y: g.ball.y };
    const p = g.players.find((o) => o.id === id && o.dead === 0);
    return p ? { x: p.x, y: p.y } : null;
  };
  const pred: Predictor = {
    game: g,
    me: null,
    pending: 0,
    corrections: 0,
    myCorrection: 0,
    takeMaxCorrection: () => ({ me: 0, ball: 0, others: 0 }),
    setMe() {},
    reset() {},
    tick: () => null,
    snapshot() {},
    remoteInput() {},
    pos,
    decay() {},
  };
  renderer.draw(pred, 0, createParticles(), { rtt: null, banners: false });
}

/** Scores and scorers of a match (to pick one). */
function summary(spec: MatchSpec) {
  const { g, bundle } = playMatch(spec);
  return {
    score: g.score,
    ticks: g.tick,
    goals: bundle.goals.map((c) => ({ by: c.by, team: c.team, arena: c.arena, second: c.second })),
  };
}

/** `view`: 'results' or 'goals'; `me`: whose results screen it is. */
function show(spec: MatchSpec, view: 'results' | 'goals', me = 'red-0') {
  const { g, bundle, bytes } = playMatch(spec);
  for (const p of g.players) p.bot = false;
  backdrop(g);
  const results = createResults();
  const goals = createGoals(createSound(), {
    opened: () => results.hold(true),
    closed: () => results.hold(false),
  });
  results.show(g, me);
  results.hold(true);
  results.goals(bundle.goals.length, () =>
    goals.open(bundle, `Red ${g.score[0]} – ${g.score[1]} Blue · just now`, bytes),
  );
  if (view === 'goals') goals.open(bundle, `Red ${g.score[0]} – ${g.score[1]} Blue · just now`, bytes);
  return true;
}

window.shots = { summary, show };
