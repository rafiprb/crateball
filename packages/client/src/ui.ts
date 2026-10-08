import type { RoomInfo, RoomListing, RoomPlayer, Seat } from '@crateball/protocol';
import {
  ARENAS,
  ITEM_KINDS,
  SETTING_CHOICES,
  defaultWeights,
  type ItemKind,
  type Role,
  type Settings,
  type Team,
} from '@crateball/sim';

/** Tiny DOM helper: text always goes through textContent (player names are untrusted). */
type Child = Node | string | null | false | undefined;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string; data?: Record<string, string> } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, data, ...rest } = props;
  if (cls) el.className = cls;
  if (data) Object.assign(el.dataset, data);
  Object.assign(el, rest);
  for (const c of children) if (c !== null && c !== false && c !== undefined) el.append(c);
  return el;
}

const ITEM_LABEL: Record<ItemKind, string> = {
  gun: 'Gun',
  mine: 'Mine',
  ice: 'Ice',
  dizzy: 'Dizzy',
  boost: 'Speed',
  shield: 'Shield',
  power: 'Power kick',
  teleport: 'Teleport',
  bazooka: 'Bazooka',
};

const ARENA_CHIP: Record<string, [string, string]> = {
  classic: ['Classic', '#5E9A48'],
  rain: ['Rain', '#4C7AA8'],
  volcano: ['Volcano', '#D0502A'],
  ice: ['Ice', '#8FC3E3'],
  wind: ['Wind', '#9AB86A'],
  beach: ['Beach', '#E0B060'],
};

export const ROLE_LABEL: Record<Role, string> = { gk: 'GK', def: 'DF', mid: 'MF', fwd: 'FW', none: '–' };
const ROLE_NAME: Record<Role, string> = {
  gk: 'Goalkeeper',
  def: 'Defender',
  mid: 'Midfielder',
  fwd: 'Forward',
  none: 'No role',
};
/** Crate items in the lobby: the helpful ones first, with their in-game colours. */
const ITEM_GOOD: readonly ItemKind[] = ['gun', 'boost', 'shield', 'power', 'teleport', 'bazooka'];
const ITEM_BAD: readonly ItemKind[] = ['mine', 'ice', 'dizzy'];
const ITEM_COLOR: Record<ItemKind, string> = {
  gun: '#FFE066',
  mine: '#FF6A3D',
  ice: '#9BE3FF',
  dizzy: '#9FE8C8',
  boost: '#7CFF7A',
  shield: '#7AF0FF',
  power: '#FFA94D',
  teleport: '#C77DFF',
  bazooka: '#B8C890',
};
type Weights = Settings['weights'];
const total = (w: Weights) => ITEM_KINDS.reduce((a, k) => a + w[k], 0);
/** Scale to whole numbers adding up to exactly 100 (largest remainder), keeping zeros at zero. */
function to100(w: Weights): Weights {
  const t = total(w) || 1;
  const exact = ITEM_KINDS.map((k) => ({ k, x: (100 * w[k]) / t }));
  const out = { ...w };
  for (const e of exact) out[e.k] = Math.floor(e.x);
  let left = 100 - total(out);
  for (const e of [...exact].sort((a, b) => (b.x % 1) - (a.x % 1))) {
    if (left <= 0) break;
    if (e.x > 0) {
      out[e.k]++;
      left--;
    }
  }
  return out;
}
const WEIGHT_PRESETS: Record<string, () => Weights> = {
  Default: defaultWeights,
  Friendly: () => {
    const w = defaultWeights();
    for (const k of ITEM_KINDS) w[k] = ITEM_GOOD.includes(k) ? w[k] * 2 : w[k] / 2;
    return to100(w);
  },
  Mean: () => {
    const w = defaultWeights();
    for (const k of ITEM_KINDS) w[k] = ITEM_GOOD.includes(k) ? w[k] / 2 : w[k] * 2;
    return to100(w);
  },
  'Guns only': () => {
    const w = defaultWeights();
    for (const k of ITEM_KINDS) w[k] = 0;
    return { ...w, gun: 75, bazooka: 25 };
  },
};
const ROLE_HINT: Record<Role, string> = {
  none: 'No passive; play anywhere',
  gk: 'Catches hard shots near your goal, nimble there',
  def: 'Shoulder charge in your half: shoves and slows',
  mid: 'Soft first touch + pass lock across midfield',
  fwd: 'Fastest; near misses curl inside the post',
};

export interface UiActions {
  create(roomName: string, isPublic: boolean): void;
  meta(roomName: string, isPublic: boolean): void;
  join(code: string): void;
  leave(): void;
  team(team: Seat): void;
  move(id: string, team: Seat): void;
  swap(a: string, b: string): void;
  kick(id: string): void;
  role(role: Role): void;
  settings(s: Settings): void;
  start(): void;
  mute(m: boolean): void;
}

export interface Ui {
  readonly name: string;
  menu(prefillCode?: string): void;
  /** Opened from a room link: the room, a nickname field and a big Join. */
  invite(code: string): void;
  lobby(room: RoomInfo, me: string | null): void;
  hide(): void;
  readonly screen: string;
}

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

/** A phone or tablet: only a coarse pointer (finger) and no fine one (mouse/trackpad). */
const touchOnly = () => matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;

export function createUi(root: HTMLElement, act: UiActions, opts: { name?: string; muted: boolean }): Ui {
  let name = opts.name ?? store.get('name') ?? '';
  if (opts.name) store.set('name', opts.name);
  let screen = 'none';
  let listTimer: ReturnType<typeof setInterval> | null = null;

  // A crate-share slider mid-drag only tells the room on release; if the lobby is rebuilt before that
  // (someone joins, a role changes), send what it shows first so the edit is not lost.
  let pendingWeights: (() => void) | null = null;

  const show = (id: string, ...children: Child[]) => {
    if (pendingWeights) {
      const send = pendingWeights;
      pendingWeights = null;
      send();
    }
    if (listTimer) clearInterval(listTimer);
    listTimer = null;
    screen = id;
    root.hidden = false;
    root.replaceChildren(h('div', { class: 'panel', id: `screen-${id}` }, ...children));
  };

  const nameField = () => {
    const input = h('input', {
      id: 'name',
      maxLength: 16,
      value: name,
      placeholder: 'Your nickname',
      autocomplete: 'off',
    });
    input.addEventListener('input', () => {
      name = input.value.trim();
      store.set('name', name);
    });
    return h('label', {}, 'Nickname', input);
  };

  const needName = (): boolean => {
    if (name) return true;
    const input = root.querySelector<HTMLInputElement>('#name');
    input?.focus();
    input?.classList.add('shake');
    setTimeout(() => input?.classList.remove('shake'), 400);
    return false;
  };

  const button = (text: string, onclick: () => void, cls = '') =>
    h('button', { type: 'button', class: cls, onclick }, text);

  const settingsForm = (s: Settings, editable: boolean, onChange: (s: Settings) => void) => {
    const select = <K extends 'minutes' | 'scoreLimit' | 'crates'>(
      key: K,
      label: string,
      fmt: (v: Settings[K]) => string,
    ) => {
      const sel = h('select', { disabled: !editable, data: { setting: key } });
      for (const v of SETTING_CHOICES[key] as unknown as readonly Settings[K][]) {
        sel.append(h('option', { value: String(v), selected: v === s[key] }, fmt(v)));
      }
      sel.addEventListener('change', () => {
        const raw = sel.value;
        const v = (key === 'crates' ? raw : Number(raw)) as Settings[K];
        onChange({ ...s, [key]: v });
      });
      return h('label', {}, label, sel);
    };
    // Crate shares: one slider per item, 0..100. They never add up to more than 100: lowering one puts
    // the difference in a free pool, raising one can only take what is in the pool. Labels follow the
    // drag; the room only hears about it on release (a re-render mid-drag would drop the slider).
    const weightSliders = () => {
      const w: Weights = { ...s.weights };
      const free = () => 100 - total(w);
      const rows = new Map<ItemKind, { input: HTMLInputElement; val: HTMLElement; row: HTMLElement }>();
      const goodTxt = h('span', { class: 'good' });
      const badTxt = h('span', { class: 'bad' });
      const barGood = h('i', { class: 'good' });
      const barFree = h('i', { class: 'free' });
      const barBad = h('i', { class: 'bad' });
      const pool = h('div', { class: 'pool' });
      const presetRow = h('div', { class: 'presets' });
      const send = () => onChange({ ...s, weights: { ...w } });
      const sync = () => {
        for (const [k, r] of rows) {
          r.input.value = String(w[k]);
          r.val.textContent = `${w[k]}%`;
          r.row.classList.toggle('off', w[k] === 0);
        }
        const good = ITEM_GOOD.reduce((a, k) => a + w[k], 0);
        const bad = ITEM_BAD.reduce((a, k) => a + w[k], 0);
        goodTxt.textContent = `Good ${good}%`;
        badTxt.textContent = `Bad ${bad}%`;
        barGood.style.width = `${good}%`;
        barFree.style.width = `${free()}%`;
        barBad.style.width = `${bad}%`;
        const f = free();
        const parts: Node[] = [];
        if (f === 0) parts.push(h('span', {}, 'All 100% given out. Lower one to raise another.'));
        else if (!editable) parts.push(h('span', {}, `Free: ${f}% (shared out among the rest).`));
        else {
          parts.push(h('span', {}, `Free: ${f}%. Raise another item, or `));
          parts.push(
            button('spread it', () => {
              Object.assign(w, to100(w));
              sync();
              send();
            }),
          );
        }
        pool.replaceChildren(...parts);
        presetRow.replaceChildren(
          ...Object.entries(WEIGHT_PRESETS).map(([name, make]) => {
            const p = make();
            const on = ITEM_KINDS.every((k) => p[k] === w[k]);
            const b = h('button', { type: 'button', class: on ? 'on' : '', disabled: !editable }, name);
            b.addEventListener('click', () => {
              Object.assign(w, make());
              sync();
              send();
            });
            return b;
          }),
        );
      };
      const column = (title: string, cls: string, kinds: readonly ItemKind[]) =>
        h(
          'div',
          {},
          h('div', { class: `grp ${cls}` }, title),
          ...kinds.map((k) => {
            const input = h('input', {
              type: 'range',
              min: '0',
              max: '100',
              step: '1',
              disabled: !editable,
              data: { weight: k },
            });
            input.setAttribute('aria-label', `${ITEM_LABEL[k]} share`);
            input.addEventListener('input', () => {
              let v = Math.min(Number(input.value), w[k] + free());
              // At least one item stays in.
              if (v === 0 && ITEM_KINDS.every((o) => o === k || w[o] === 0)) v = 1;
              w[k] = v;
              sync();
              pendingWeights = send;
            });
            input.addEventListener('change', () => {
              pendingWeights = null;
              send();
            });
            const val = h('span', { class: 'val' });
            const row = h(
              'div',
              { class: 'wrow' },
              h('i', { class: 'dot' }),
              h('span', { class: 'wname' }, ITEM_LABEL[k]),
              input,
              val,
            );
            row.style.setProperty('--c', ITEM_COLOR[k]);
            rows.set(k, { input, val, row });
            return row;
          }),
        );
      const fs = h(
        'fieldset',
        { class: 'loot weights' },
        h('legend', {}, 'Crate contents'),
        presetRow,
        h('div', { class: 'bal-txt' }, goodTxt, badTxt),
        h('div', { class: 'balance' }, barGood, barFree, barBad),
        h('div', { class: 'wcols' }, column('Good', 'good', ITEM_GOOD), column('Bad', 'bad', ITEM_BAD)),
        pool,
      );
      sync();
      return fs;
    };
    // Which arenas the match draws from (a new one each kickoff); at least one stays ticked.
    const arenaBoxes = () => {
      const pool = s.arenas ?? ARENAS.kinds;
      return h(
        'fieldset',
        { class: 'loot arenas' },
        h('legend', {}, 'Arenas'),
        ...ARENAS.kinds.map((kind) => {
          const box = h('input', {
            type: 'checkbox',
            checked: pool.includes(kind),
            disabled: !editable,
            data: { arena: kind },
          });
          box.addEventListener('change', () => {
            const next = box.checked ? [...pool, kind] : pool.filter((k) => k !== kind);
            if (next.length === 0) {
              box.checked = true;
              return;
            }
            onChange({ ...s, arenas: ARENAS.kinds.filter((k) => next.includes(k)) });
          });
          const [label, color] = ARENA_CHIP[kind] ?? [kind, '#666'];
          const chip = h('span', { class: 'chip' }, label);
          chip.style.setProperty('--chip', color);
          return h('label', { class: 'check' }, box, chip);
        }),
      );
    };
    const bots = h('input', { type: 'checkbox', checked: s.bots, disabled: !editable });
    bots.addEventListener('change', () => onChange({ ...s, bots: bots.checked }));
    const roles = h('input', {
      type: 'checkbox',
      checked: s.roles !== false,
      disabled: !editable,
      id: 'roles-on',
    });
    roles.addEventListener('change', () => onChange({ ...s, roles: roles.checked }));
    return h(
      'div',
      { class: 'settings' },
      select('minutes', 'Match length', (v) => (v === 0 ? 'No time limit' : `${v} min`)),
      select('scoreLimit', 'Score limit', (v) => `First to ${v}`),
      select(
        'crates',
        'Crates',
        (v) => ({ off: 'Off', normal: 'Normal', chaos: 'Chaos' })[v as string] ?? '',
      ),
      weightSliders(),
      arenaBoxes(),
      h('label', { class: 'check' }, bots, 'Fill with bots'),
      h('label', { class: 'check' }, roles, 'Positions (role passives)'),
    );
  };

  const ui: Ui = {
    get name() {
      return name || 'Player';
    },
    get screen() {
      return screen;
    },
    hide() {
      if (listTimer) clearInterval(listTimer);
      screen = 'none';
      root.hidden = true;
    },
    menu(prefill) {
      const code = h('input', {
        id: 'code',
        maxLength: 4,
        placeholder: 'CODE',
        value: prefill ?? '',
        autocomplete: 'off',
      });
      code.addEventListener('input', () => (code.value = code.value.toUpperCase().replace(/[^A-Z]/g, '')));
      const joinCode = () => {
        if (!needName()) return;
        if (code.value.length === 4) act.join(code.value);
        else code.focus();
      };
      code.addEventListener('keydown', (e) => e.key === 'Enter' && joinCode());
      const mute = h('input', { type: 'checkbox', checked: opts.muted });
      mute.addEventListener('change', () => {
        opts.muted = mute.checked;
        act.mute(mute.checked);
      });
      show(
        'menu',
        h('h1', {}, 'Crateball'),
        h('p', { class: 'sub' }, '3v3 arcade football. Crates drop guns, mines and ice.'),
        touchOnly() &&
          h(
            'p',
            { class: 'notice', role: 'note' },
            'Phones and tablets aren’t supported yet: Crateball needs a keyboard. Open it on a computer to play.',
          ),
        nameField(),
        button('Create Room', () => needName() && create(), 'primary'),
        button('Find Room', () => needName() && find()),
        h('div', { class: 'row' }, code, button('Join with Code', joinCode)),
        h('label', { class: 'check' }, mute, 'Mute sounds (M)'),
      );
      if (prefill) code.focus();
    },
    invite(code) {
      const info = h('p', { class: 'sub' }, '');
      const join = () => needName() && act.join(code);
      const field = nameField();
      field.querySelector('input')?.addEventListener('keydown', (e) => e.key === 'Enter' && join());
      show(
        'invite',
        h('h1', {}, 'Crateball'),
        h('p', { class: 'sub' }, 'You were invited to a room.'),
        h('div', { class: 'invite' }, h('span', { class: 'code', id: 'invite-code' }, code)),
        info,
        field,
        button('Join', join, 'primary'),
        button('Back to menu', () => {
          history.replaceState(null, '', '/');
          ui.menu();
        }),
      );
      const input = root.querySelector<HTMLInputElement>('#name');
      if (input && !input.value) input.focus();
      // Public rooms are listed: show which one it is and whether a match is on.
      void fetch('/rooms')
        .then(async (res) => (await res.json()) as RoomListing[])
        .then((list) => {
          const r = list.find((x) => x.code === code);
          if (!r) return;
          info.textContent =
            `${r.name} · ${r.humans}/${r.max} players` +
            (r.state === 'playing' ? ' · match on: you watch until the next one' : '');
        })
        .catch(() => {});
    },
    lobby(room, me) {
      const isHost = room.host === me;
      const roomNameInput = (r: RoomInfo) => {
        const input = h('input', {
          id: 'room-name',
          maxLength: 24,
          value: r.name,
          autocomplete: 'off',
          class: 'room-name',
        });
        const commit = () => {
          const v = input.value.trim();
          if (v && v !== r.name) act.meta(v, r.public);
        };
        input.addEventListener('change', commit);
        input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
        return input;
      };
      const publicBox = () => {
        const box = h('input', {
          type: 'checkbox',
          checked: room.public,
          disabled: !isHost,
          id: 'room-public',
        });
        box.addEventListener('change', () => act.meta(room.name, box.checked));
        return h('label', { class: 'check' }, box, 'Public (shows up in Find Room)');
      };
      const mine = room.players.find((p) => p.id === me);
      const link = `${location.origin}/r/${room.code}`;
      const copy = button('Copy link', () => {
        void navigator.clipboard?.writeText(link).then(() => (copy.textContent = 'Copied!'));
      });
      // Drag & drop: the host can drag anyone (onto a player = swap, onto a column = move);
      // everyone can drag themselves to the other column.
      const canDrag = (p: RoomPlayer) => isHost || p.id === me;
      const player = (p: RoomPlayer) => {
        const li = h(
          'li',
          { class: p.id === me ? 'me' : '', draggable: canDrag(p), data: { id: p.id } },
          h('span', { class: 'role' }, ROLE_LABEL[p.role]),
          h('span', { class: 'pname' }, p.name),
          h('span', { class: 'rname' }, ROLE_NAME[p.role]),
          p.id === room.host && h('span', { class: 'tag' }, 'HOST'),
          p.bot && h('span', { class: 'tag' }, 'BOT'),
          isHost &&
            !p.bot &&
            p.id !== me &&
            h(
              'button',
              { class: 'kick', title: `Remove ${p.name} from the room`, onclick: () => act.kick(p.id) },
              '✕',
            ),
        );
        li.addEventListener('dragstart', (e) => {
          e.dataTransfer?.setData('text/plain', p.id);
          li.classList.add('dragging');
        });
        li.addEventListener('dragend', () => li.classList.remove('dragging'));
        if (isHost) {
          li.addEventListener('dragover', (e) => {
            e.preventDefault();
            li.classList.add('over');
          });
          li.addEventListener('dragleave', () => li.classList.remove('over'));
          li.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const from = e.dataTransfer?.getData('text/plain');
            if (from && from !== p.id) act.swap(from, p.id);
          });
        }
        return li;
      };
      const column = (team: Team) => {
        const col = h(
          'div',
          { class: `team ${team}`, data: { team } },
          h('h3', {}, team === 'red' ? 'Red' : 'Blue'),
          h('ul', {}, ...room.players.filter((p) => p.team === team).map(player)),
          mine?.team !== team && button(`Join ${team === 'red' ? 'Red' : 'Blue'}`, () => act.team(team)),
        );
        col.addEventListener('dragover', (e) => {
          e.preventDefault();
          col.classList.add('over');
        });
        col.addEventListener('dragleave', () => col.classList.remove('over'));
        col.addEventListener('drop', (e) => {
          e.preventDefault();
          col.classList.remove('over');
          const id = e.dataTransfer?.getData('text/plain');
          if (id) act.move(id, team);
        });
        return col;
      };
      // Watching, not playing: drop anyone here (host) or yourself; they take a seat again from the lobby.
      const spectator = (s: { id: string; name: string }) => {
        const li = h(
          'li',
          { class: s.id === me ? 'me' : '', draggable: isHost || s.id === me, data: { id: s.id } },
          h('span', { class: 'pname' }, s.name),
          s.id === room.host && h('span', { class: 'tag' }, 'HOST'),
          isHost &&
            s.id !== me &&
            h(
              'button',
              { class: 'kick', title: `Remove ${s.name} from the room`, onclick: () => act.kick(s.id) },
              '✕',
            ),
        );
        li.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/plain', s.id));
        return li;
      };
      const specBox = h(
        'div',
        { class: 'spectators' },
        h('h3', {}, 'Spectators'),
        room.spectators.length
          ? h('ul', {}, ...room.spectators.map(spectator))
          : h('span', { class: 'empty' }, 'Nobody is watching'),
      );
      specBox.addEventListener('dragover', (e) => {
        e.preventDefault();
        specBox.classList.add('over');
      });
      specBox.addEventListener('dragleave', () => specBox.classList.remove('over'));
      specBox.addEventListener('drop', (e) => {
        e.preventDefault();
        specBox.classList.remove('over');
        const id = e.dataTransfer?.getData('text/plain');
        if (id) act.move(id, 'spec');
      });
      const spectators = h(
        'div',
        { class: 'spectators-row' },
        specBox,
        mine && button('Watch', () => act.team('spec')),
      );
      // A real position is one per team: taken by a human teammate = greyed out (a bot just swaps).
      // "No role" is open to everyone.
      const takenBy = (r: Role) =>
        r === 'none' || !mine
          ? undefined
          : room.players.find((p) => p.team === mine.team && p.role === r && !p.bot && p.id !== me);
      const roles = h(
        'div',
        { class: 'roles' },
        ...(['gk', 'def', 'mid', 'fwd', 'none'] as const).map((r) => {
          const owner = takenBy(r);
          return h(
            'button',
            {
              type: 'button',
              class: mine?.role === r ? 'on' : '',
              title: owner ? `${owner.name} plays ${ROLE_NAME[r]}` : ROLE_HINT[r],
              disabled: owner !== undefined,
              onclick: () => act.role(r),
              data: { role: r },
            },
            h('b', {}, ROLE_LABEL[r]),
            ` ${ROLE_NAME[r]}`,
          );
        }),
      );
      const rolesOn = room.settings.roles !== false;
      show(
        'lobby',
        h(
          'div',
          { class: 'head' },
          isHost ? roomNameInput(room) : h('h2', {}, room.name),
          h('span', { class: 'code', id: 'room-code' }, room.code),
          copy,
        ),
        // Two panes side by side (people on the left, the match on the right), so it fits without scrolling.
        h(
          'div',
          { class: 'lobby-cols' },
          h(
            'div',
            { class: 'pane' },
            h('div', { class: 'teams' }, column('red'), column('blue')),
            spectators,
            mine && h('h3', {}, 'Pick your position'),
            mine && rolesOn && roles,
            mine &&
              h(
                'div',
                { class: 'hint' },
                rolesOn
                  ? `${ROLE_NAME[mine.role]}: ${ROLE_HINT[mine.role]}`
                  : 'Positions are off for this match.',
              ),
            h('div', { id: 'chat-slot' }),
          ),
          h(
            'div',
            { class: 'pane' },
            settingsForm(room.settings, isHost, act.settings),
            publicBox(),
            h(
              'div',
              { class: 'actions' },
              isHost
                ? button('Start Game', act.start, 'primary')
                : h('p', { class: 'hint' }, 'Waiting for the host to start…'),
              button('Leave', act.leave),
            ),
          ),
        ),
      );
    },
  };

  /** Create Room goes straight to the lobby; name, visibility and rules are edited there. */
  function create() {
    act.create(`${name || 'Player'}'s room`, true);
  }

  function find() {
    const search = h('input', { placeholder: 'Search rooms…', autocomplete: 'off' });
    const list = h('ul', { class: 'rooms' });
    let rooms: RoomListing[] = [];
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const shown = rooms.filter(
        (r) => !q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q),
      );
      list.replaceChildren(
        ...(shown.length
          ? shown.map((r) =>
              h(
                'li',
                {},
                h('span', { class: 'pname' }, r.name),
                h('span', { class: 'tag' }, r.code),
                h('span', { class: 'tag' }, `${r.humans}/${r.max}`),
                h('span', { class: 'tag' }, r.state === 'playing' ? 'Playing' : 'Lobby'),
                r.full ? h('span', { class: 'tag' }, 'Full') : button('Join', () => act.join(r.code)),
              ),
            )
          : [h('li', { class: 'empty' }, 'No public rooms yet — create one!')]),
      );
    };
    const load = async () => {
      try {
        rooms = (await (await fetch('/rooms')).json()) as RoomListing[];
      } catch {
        rooms = [];
      }
      draw();
    };
    search.addEventListener('input', draw);
    show(
      'find',
      h('h2', {}, 'Find Room'),
      search,
      list,
      button('Back', () => ui.menu()),
    );
    void load();
    listTimer = setInterval(() => void load(), 3000);
  }
  return ui;
}
