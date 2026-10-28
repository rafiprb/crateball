/**
 * Steam achievements (main app only): four lifetime counters kept as Steam stats, each with tiers.
 * The only list there is: the client unlocks from it (`steam.ts`), and `desktop/steam/achievements.mjs`
 * makes the Steamworks import file and the icons from it. No imports, so that script can load it as is.
 */

/** What a match adds to, and the Steam stat (API name) that keeps the lifetime total. */
export const COUNTERS = {
  goals: 'GOALS',
  saves: 'KEEPER_SAVES',
  passes: 'PASSES',
  wins: 'WINS',
} as const;
export type Counter = keyof typeof COUNTERS;

export interface Achievement {
  /** Steam API name. */
  id: string;
  counter: Counter;
  /** Unlocks once the lifetime total reaches this. */
  at: number;
  name: string;
  description: string;
}

const TIERS = [5, 10, 50, 100, 150, 200, 250, 300, 350] as const;

const NAMES: Record<Counter, readonly string[]> = {
  goals: [
    'First Goal',
    'Off the Mark',
    'Double Figures',
    'Sharpshooter',
    'Centurion',
    'Goal Machine',
    'Net Buster',
    'Golden Boot',
    'Hall of Fame',
    'Living Legend',
  ],
  wins: [
    'First Win',
    'Winning Habit',
    'Ten Up',
    'Contender',
    'Champion',
    'Dynasty',
    'Unstoppable',
    'Trophy Cabinet',
    'Untouchable',
    'Immortal',
  ],
  saves: [
    'Safe Hands',
    'Shot Stopper',
    'The Wall',
    'Gloves of Steel',
    'Last Line',
    'No Way Through',
    'Iron Curtain',
    'Golden Glove',
    'Keeper Legend',
  ],
  passes: [
    'Team Player',
    'Link-Up',
    'Playmaker',
    'Maestro',
    'Metronome',
    'Conductor',
    'Puppet Master',
    'Visionary',
    'Pass Master',
  ],
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const DESCRIBE: Record<Counter, (n: number) => string> = {
  goals: (n) =>
    n === 1
      ? 'Score your first goal against human opponents.'
      : `Score ${plural(n, 'goal', 'goals')} against human opponents.`,
  wins: (n) =>
    n === 1
      ? 'Win your first match against human opponents.'
      : `Win ${plural(n, 'match', 'matches')} against human opponents.`,
  saves: (n) => `Make ${plural(n, 'save', 'saves')} as goalkeeper against human opponents.`,
  passes: (n) => `Complete ${plural(n, 'pass', 'passes')} against human opponents.`,
};

/** Goals and wins also have a first one (at 1) before the tiers. */
const FIRST: Partial<Record<Counter, string>> = { goals: 'FIRST_GOAL', wins: 'FIRST_WIN' };

export const ACHIEVEMENTS: readonly Achievement[] = (Object.keys(COUNTERS) as Counter[]).flatMap(
  (counter) => {
    const first = FIRST[counter];
    const steps: Array<[string, number]> = [
      ...(first ? [[first, 1] as [string, number]] : []),
      ...TIERS.map((n): [string, number] => [`${COUNTERS[counter]}_${n}`, n]),
    ];
    return steps.map(([id, at], i) => ({
      id,
      counter,
      at,
      name: NAMES[counter][i]!,
      description: DESCRIBE[counter](at),
    }));
  },
);

/** Every achievement the lifetime totals have reached (already unlocked ones too: unlocking is idempotent). */
export function reached(totals: Partial<Record<Counter, number>>): string[] {
  return ACHIEVEMENTS.filter((a) => (totals[a.counter] ?? 0) >= a.at).map((a) => a.id);
}
