/**
 * The goals popup: a match's goals in a list, each replayed with the game's own renderer (replay.ts), and
 * downloadable as a `.crateball` file that opens back here (double-click in the desktop build, dropped on
 * the page anywhere). Opened from the results screen and from the menu's recent matches.
 */
import { encodeReplays, type GoalClip, type ReplayBundle } from '@crateball/protocol';
import { TICK_HZ, type Team } from '@crateball/sim';
import { createEventTracker } from './events';
import { createParticles } from './particles';
import { createRenderer } from './render';
import { playClip, type ClipRun } from './replay';
import type { Sound } from './sound';
import { h } from './ui';

export interface Goals {
  readonly visible: boolean;
  /** `title`: what the match was ("Red 5 – 3 Blue · just now"); `bytes`: the bundle as received or
   * opened (downloaded as it is for "all goals"). */
  open(bundle: ReplayBundle, title: string, bytes: Uint8Array): void;
  /** A file that cannot be played: made with another version of the game, or not a replay at all. */
  problem(why: 'version' | 'broken'): void;
  close(): void;
}

const ARENA_NAME: Record<string, string> = {
  classic: 'Classic',
  rain: 'Rain',
  volcano: 'Volcano',
  ice: 'Ice',
  wind: 'Wind',
  beach: 'Beach',
};
const TEAM_NAME: Record<Team, string> = { red: 'Red', blue: 'Blue' };

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
/** "2026-10-09-2140" in local time. */
const stamp = (at: number) => {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20) || 'player';

/** Hands the bytes to the browser as a download (the desktop build saves it to Downloads). */
function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/x-crateball' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function createGoals(sound: Sound, hooks: { opened(): void; closed(): void }): Goals {
  const dialog = h('dialog', { id: 'goals' });
  dialog.setAttribute('aria-labelledby', 'goals-title');
  document.body.append(dialog);

  const title = h('h2', { id: 'goals-title' }, 'Goals');
  const sub = h('span', { class: 'sub' });
  const list = h('div', { class: 'glist' });
  const canvas = h('canvas');
  const note = h('div', { class: 'gnote', hidden: true });
  const stage = h('div', { class: 'stage' }, canvas, note);
  const caption = h('div', { class: 'gcap' });
  const playBtn = h('button', { type: 'button', class: 'gplay', title: 'Play / pause (Space)' }, '❚❚');
  const again = h('button', { type: 'button', title: 'Watch again' }, '↺');
  const speeds = [0.5, 1].map((s) =>
    h('button', { type: 'button', class: `speed${s === 1 ? ' on' : ''}`, data: { s: String(s) } }, `${s}×`),
  );
  const fill = h('div', { class: 'fill' });
  const mark = h('div', { class: 'mark' });
  const bar = h('div', { class: 'bar', title: 'Jump to a moment' }, fill, mark);
  const time = h('span', { class: 'time' });
  const dlOne = h('button', { type: 'button' }, '⬇ Download this goal');
  const dlAll = h('button', { type: 'button', class: 'ghost' });
  const close = h('button', { type: 'button', class: 'close', title: 'Close (Esc)' }, '✕');
  close.setAttribute('aria-label', 'Close');
  dialog.append(
    h(
      'div',
      { class: 'gbox' },
      h('header', { class: 'ghead' }, title, sub, close),
      list,
      h(
        'div',
        { class: 'gview' },
        stage,
        caption,
        h('div', { class: 'ctrl' }, playBtn, again, ...speeds, bar, time),
        h(
          'div',
          { class: 'dl' },
          dlOne,
          dlAll,
          h(
            'span',
            { class: 'hint' },
            'A small .crateball file. Open it in Crateball: drop it on the game, or double-click it if you play the Steam version.',
          ),
        ),
      ),
    ),
  );

  const problemBox = h('dialog', { id: 'replay-problem' });
  const problemText = h('p');
  problemBox.append(
    h('h2', {}, 'Can’t play this replay'),
    problemText,
    h('button', { type: 'button', class: 'primary', onclick: () => problemBox.close() }, 'OK'),
  );
  document.body.append(problemBox);
  // Esc closes this one only, not the results screen under it.
  problemBox.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') e.stopPropagation();
  });

  const renderer = createRenderer(canvas);
  let fx = createParticles();
  let track = createEventTracker();
  let bundle: ReplayBundle | null = null;
  let raw: Uint8Array | null = null;
  let cur = 0;
  let run: ClipRun | null = null;
  /** Clips already found not to play out as on the server. */
  let broken = new Set<number>();
  let playing = false;
  let speed = 1;
  let acc = 0;
  let last = 0;
  let frame = 0;

  const size = () => {
    const r = stage.getBoundingClientRect();
    if (r.width > 0) renderer.resize(r.width, r.height, devicePixelRatio);
  };
  const resizer = new ResizeObserver(size);
  resizer.observe(stage);

  const setPlaying = (on: boolean) => {
    playing = on && run !== null;
    playBtn.textContent = playing ? '❚❚' : '▶';
  };

  const showNote = (text: string | null) => {
    note.hidden = text === null;
    note.textContent = text ?? '';
  };

  const updateBar = () => {
    if (!run) {
      fill.style.width = '0';
      time.textContent = '';
      return;
    }
    fill.style.width = `${(run.at / run.length) * 100}%`;
    const rel = (run.at - run.goalAt) / TICK_HZ;
    time.textContent = `${rel < 0 ? '−' : '+'}${Math.abs(rel).toFixed(1)}`;
  };

  /** A fresh tracker that has already seen the current state: no sounds for what was skipped. */
  const resync = () => {
    track = createEventTracker();
    if (run) track(run.game);
    fx = createParticles();
  };

  const select = (i: number) => {
    if (!bundle) return;
    cur = i;
    for (const [k, el] of [...list.children].entries()) el.classList.toggle('sel', k === i);
    const g = bundle.goals[i]!;
    const who = g.by ?? TEAM_NAME[g.team];
    caption.replaceChildren(
      h('span', { class: `gteam ${g.team}` }, g.team.toUpperCase()),
      ` ${g.ownGoal ? `${who} (own goal)` : `${who} scores`}`,
      g.assist ? h('span', { class: 'assist' }, `assist ${g.assist}`) : '',
    );
    run = broken.has(i) ? null : playClip(g);
    if (!run) {
      broken.add(i);
      list.children[i]?.classList.add('broken');
      showNote('This goal can’t be replayed.');
    } else showNote(null);
    dlOne.disabled = run === null;
    mark.style.left = run ? `${(run.goalAt / run.length) * 100}%` : '0';
    resync();
    updateBar();
    setPlaying(true);
    acc = 0;
  };

  const item = (g: GoalClip, i: number) =>
    h(
      'button',
      { type: 'button', class: `gitem ${g.team}`, onclick: () => select(i) },
      h('span', { class: 'min' }, clock(g.second)),
      h(
        'span',
        { class: 'who' },
        h('span', { class: 'pname' }, g.by ?? TEAM_NAME[g.team]),
        g.ownGoal && h('span', { class: 'tag og' }, 'OWN GOAL'),
      ),
      h(
        'span',
        { class: 'meta' },
        g.assist && `assist ${g.assist}`,
        h('span', { class: 'tag' }, ARENA_NAME[g.arena] ?? g.arena),
      ),
    );

  const loop = (now: number) => {
    if (!dialog.open) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (run && playing) {
      acc += dt * speed * TICK_HZ;
      while (acc >= 1) {
        acc -= 1;
        if (!run.advance()) {
          setPlaying(false);
          acc = 0;
          break;
        }
        for (const e of track(run.game)) {
          sound.play(e);
          fx.emit(e);
        }
      }
      updateBar();
    }
    if (run) {
      const alpha = playing ? Math.min(1, acc) : 1;
      fx.ambient(run.game, (id) => run!.pred.pos(id, alpha), dt * (playing ? speed : 0));
      fx.update(playing ? dt * speed : 0);
      renderer.draw(run.pred, alpha, fx, { rtt: null, replay: true });
    }
    frame = requestAnimationFrame(loop);
  };

  const seekTo = (clientX: number) => {
    if (!run) return;
    const r = bar.getBoundingClientRect();
    run.seek(((clientX - r.left) / r.width) * run.length);
    acc = 0;
    resync();
    updateBar();
  };

  playBtn.onclick = () => {
    if (run && !playing && run.at >= run.length) {
      run.seek(0);
      resync();
    }
    setPlaying(!playing);
  };
  again.onclick = () => {
    if (!run) return;
    run.seek(0);
    resync();
    updateBar();
    setPlaying(true);
  };
  for (const b of speeds)
    b.onclick = () => {
      speed = Number(b.dataset.s);
      for (const o of speeds) o.classList.toggle('on', o === b);
    };
  bar.addEventListener('pointerdown', (e) => {
    seekTo(e.clientX);
    bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener('pointermove', (e) => {
    if (bar.hasPointerCapture(e.pointerId)) seekTo(e.clientX);
  });
  dlOne.onclick = () => {
    const g = bundle?.goals[cur];
    if (!bundle || !g) return;
    const one = encodeReplays({ at: bundle.at, score: bundle.score, goals: [g] });
    download(
      one,
      `crateball-${stamp(bundle.at)}-goal-${clock(g.second).replace(':', '')}-${slug(g.by ?? g.team)}.crateball`,
    );
  };
  dlAll.onclick = () => {
    if (bundle && raw) download(raw, `crateball-${stamp(bundle.at)}-goals.crateball`);
  };
  close.onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    cancelAnimationFrame(frame);
    run = null;
    bundle = null;
    raw = null;
    hooks.closed();
  });
  // Space plays and pauses (not while a button has focus: there it presses the button).
  dialog.addEventListener('keydown', (e) => {
    if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      playBtn.click();
    }
    // Esc closes this popup only, not the results screen under it.
    if (e.key === 'Escape') e.stopPropagation();
  });

  return {
    get visible() {
      return dialog.open || problemBox.open;
    },
    open(b, what, bytes) {
      bundle = b;
      raw = bytes;
      broken = new Set();
      title.textContent = b.goals.length === 1 ? 'Goal' : 'Goals';
      sub.textContent = what;
      dlAll.hidden = b.goals.length === 1;
      dlAll.textContent = `⬇ All ${b.goals.length} goals`;
      list.replaceChildren(...b.goals.map(item));
      if (!dialog.open) {
        dialog.showModal();
        hooks.opened();
      }
      size();
      select(0);
      close.focus();
      last = performance.now();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(loop);
    },
    problem(why) {
      problemText.textContent =
        why === 'version'
          ? 'It was made with another version of Crateball, and the game has changed since. Replays play only in the version they were made in.'
          : 'This file isn’t a Crateball replay, or it got damaged.';
      if (!problemBox.open) problemBox.showModal();
    },
    close() {
      if (dialog.open) dialog.close();
      if (problemBox.open) problemBox.close();
    },
  };
}
