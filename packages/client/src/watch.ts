/**
 * Where goal replays come from and go: the match's goals at the final whistle (a button on the results
 * screen, and kept in recent matches), the menu's recent matches, and `.crateball` files (dropped on the
 * page, opened by the installed web app, or double-clicked in the desktop build, which hands them over as
 * base64 in `window.__CRATEBALL_FILES__` and a `crateball-file` event).
 */
import { REPLAY_MAX_BYTES, decodeReplays, type ReplayBundle } from '@crateball/protocol';
import type { Team } from '@crateball/sim';
import { createGoals } from './goals';
import { listRecent, saveRecent, type RecentMatch } from './recent';
import type { Results } from './results';
import type { Sound } from './sound';
import { h } from './ui';

declare global {
  interface Window {
    __CRATEBALL_FILES__?: string[];
  }
}

export interface Watch {
  readonly visible: boolean;
  /** The goals of the match that just ended, as the server sent them; `you`: our side (null: watching). */
  received(bytes: Uint8Array, you: Team | null): void;
  /** A match started: the last one's goals are off the results screen, the popup closes. */
  matchStarted(): void;
  /** Out of a match (lobby or menu): a file that arrived during one opens now. */
  idle(): void;
  /** The recent matches and the file hint, for the bottom of the menu. */
  menuSection(): HTMLElement;
}

const score = (b: { score: [number, number] }) => `Red ${b.score[0]} – ${b.score[1]} Blue`;

/** "just now", "21:40", "yesterday", "7 Oct". */
function when(at: number): string {
  const d = new Date(at);
  const now = new Date();
  if (Date.now() - at < 90_000) return 'just now';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days === 0) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "9 Oct, 21:40": a file's match. */
const dated = (at: number) =>
  `${new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;

function fromBase64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function createWatch(deps: {
  sound: Sound;
  results: Results;
  /** In a match: files wait until it is over. */
  playing(): boolean;
  say(text: string): void;
}): Watch {
  const goals = createGoals(deps.sound, {
    opened: () => deps.results.hold(true),
    closed: () => deps.results.hold(false),
  });
  /** A file opened during a match. */
  let waiting: Uint8Array | null = null;

  const openBytes = (bytes: Uint8Array) => {
    if (deps.playing()) {
      waiting = bytes;
      deps.say('The replay opens after the match.');
      return;
    }
    const d = bytes.length > REPLAY_MAX_BYTES ? null : decodeReplays(bytes);
    if (!d || !d.ok) return goals.problem(d?.why ?? 'broken');
    goals.open(d.bundle, `${score(d.bundle)} · ${dated(d.bundle.at)}`, bytes);
  };
  const openFile = async (f: File) => {
    if (f.size > REPLAY_MAX_BYTES) return goals.problem('broken');
    try {
      openBytes(new Uint8Array(await f.arrayBuffer()));
    } catch {
      goals.problem('broken');
    }
  };

  // Dropped anywhere on the page.
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
  addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.add('file-over');
  });
  addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('file-over');
  });
  addEventListener('drop', (e) => {
    document.body.classList.remove('file-over');
    if (!hasFiles(e)) return;
    e.preventDefault();
    const f = e.dataTransfer?.files[0];
    if (f) void openFile(f);
  });
  // The installed web app (Chrome, Edge): a double-clicked file arrives here (manifest `file_handlers`).
  const lq = (
    window as { launchQueue?: { setConsumer(f: (p: { files?: FileSystemFileHandle[] }) => void): void } }
  ).launchQueue;
  lq?.setConsumer((p) => {
    const f = p.files?.[0];
    if (f) void f.getFile().then(openFile, () => goals.problem('broken'));
  });
  // The desktop build.
  const takeDesktop = () => {
    const q = window.__CRATEBALL_FILES__;
    while (q?.length) {
      const bytes = fromBase64(q.shift()!);
      if (bytes) openBytes(bytes);
      else goals.problem('broken');
    }
  };
  addEventListener('crateball-file', takeDesktop);
  // Files that came before this page was ready: once the rest of the page is set up.
  setTimeout(takeDesktop, 0);

  return {
    get visible() {
      return goals.visible;
    },
    received(bytes, you) {
      const d = decodeReplays(bytes);
      if (!d.ok) return;
      const b: ReplayBundle = d.bundle;
      deps.results.goals(b.goals.length, () => goals.open(b, `${score(b)} · just now`, bytes));
      void saveRecent({ at: b.at, score: b.score, goals: b.goals.length, you, bytes });
    },
    matchStarted() {
      deps.results.goals(0, () => {});
      goals.close();
    },
    idle() {
      if (!waiting) return;
      const bytes = waiting;
      waiting = null;
      openBytes(bytes);
    },
    menuSection() {
      const list = h('div', { class: 'rlist' });
      const box = h(
        'section',
        { class: 'recent', hidden: true },
        h('h3', {}, 'Recent matches', h('small', {}, 'on this device')),
        list,
      );
      const row = (m: RecentMatch) => {
        const mine = m.you === 'red' ? m.score[0] : m.score[1];
        const theirs = m.you === 'red' ? m.score[1] : m.score[0];
        const res = m.you === null ? null : mine > theirs ? 'won' : mine < theirs ? 'lost' : 'draw';
        return h(
          'button',
          {
            type: 'button',
            class: 'rmatch',
            onclick: () => {
              const d = decodeReplays(m.bytes);
              if (!d.ok) return goals.problem(d.why);
              goals.open(d.bundle, `${score(m)} · ${when(m.at)}`, m.bytes);
            },
          },
          h('span', { class: `res ${res ?? 'spec'}` }, res ? res.toUpperCase() : 'WATCHED'),
          h(
            'span',
            { class: 'sc' },
            h('span', { class: 'red' }, String(m.score[0])),
            ' – ',
            h('span', { class: 'blue' }, String(m.score[1])),
            h('span', { class: 'when' }, when(m.at)),
          ),
          h('span', { class: 'go' }, `▶ ${m.goals} ${m.goals === 1 ? 'goal' : 'goals'}`),
        );
      };
      void listRecent().then((all) => {
        list.replaceChildren(...all.map(row));
        box.hidden = all.length === 0;
      });
      return h(
        'div',
        { class: 'replays' },
        box,
        h('p', { class: 'drop' }, 'Got a ', h('b', {}, '.crateball'), ' replay file? Drop it here.'),
      );
    },
  };
}
