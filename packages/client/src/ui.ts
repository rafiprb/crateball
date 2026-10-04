import type { RoomInfo, RoomListing, RoomPlayer } from '@crateball/protocol';
import {
  ITEM_KINDS,
  SETTING_CHOICES,
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
  boost: 'Speed',
  shield: 'Shield',
  power: 'Power kick',
  teleport: 'Teleport',
};

export const ROLE_LABEL: Record<Role, string> = { gk: 'GK', def: 'DF', mid: 'MF', fwd: 'FW' };
const ROLE_NAME: Record<Role, string> = {
  gk: 'Goalkeeper',
  def: 'Defender',
  mid: 'Midfielder',
  fwd: 'Forward',
};
const ROLE_HINT: Record<Role, string> = {
  gk: 'Bigger in your box',
  def: 'Heavier + faster in your half',
  mid: 'Longer reach + crisper passes in midfield',
  fwd: 'Fastest + hardest shot up front',
};

export interface UiActions {
  create(roomName: string, isPublic: boolean): void;
  meta(roomName: string, isPublic: boolean): void;
  join(code: string): void;
  leave(): void;
  team(team: Team): void;
  move(id: string, team: Team): void;
  swap(a: string, b: string): void;
  role(role: Role): void;
  settings(s: Settings): void;
  start(): void;
  mute(m: boolean): void;
}

export interface Ui {
  readonly name: string;
  menu(prefillCode?: string): void;
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

  const show = (id: string, ...children: Child[]) => {
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
    // Which items crates may contain; at least one stays ticked.
    const lootBoxes = () =>
      h(
        'fieldset',
        { class: 'loot' },
        h('legend', {}, 'Crate contents'),
        ...ITEM_KINDS.map((kind) => {
          const box = h('input', {
            type: 'checkbox',
            checked: s.loot.includes(kind),
            disabled: !editable,
            data: { loot: kind },
          });
          box.addEventListener('change', () => {
            const next = box.checked ? [...s.loot, kind] : s.loot.filter((k) => k !== kind);
            if (next.length === 0) {
              box.checked = true;
              return;
            }
            onChange({ ...s, loot: ITEM_KINDS.filter((k) => next.includes(k)) });
          });
          return h('label', { class: 'check' }, box, ITEM_LABEL[kind]);
        }),
      );
    const bots = h('input', { type: 'checkbox', checked: s.bots, disabled: !editable });
    bots.addEventListener('change', () => onChange({ ...s, bots: bots.checked }));
    return h(
      'div',
      { class: 'settings' },
      select('minutes', 'Match length', (v) => `${v} min`),
      select('scoreLimit', 'Score limit', (v) => `First to ${v}`),
      select(
        'crates',
        'Crates',
        (v) => ({ off: 'Off', normal: 'Normal', chaos: 'Chaos' })[v as string] ?? '',
      ),
      lootBoxes(),
      h('label', { class: 'check' }, bots, 'Fill with bots'),
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
          mine &&
            mine.team !== team &&
            button(`Join ${team === 'red' ? 'Red' : 'Blue'}`, () => act.team(team)),
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
      const roles = h(
        'div',
        { class: 'roles' },
        ...(['gk', 'def', 'mid', 'fwd'] as const).map((r) =>
          h(
            'button',
            {
              type: 'button',
              class: mine?.role === r ? 'on' : '',
              title: ROLE_HINT[r],
              onclick: () => act.role(r),
              data: { role: r },
            },
            h('b', {}, ROLE_LABEL[r]),
            ` ${ROLE_NAME[r]}`,
          ),
        ),
      );
      show(
        'lobby',
        h(
          'div',
          { class: 'head' },
          isHost ? roomNameInput(room) : h('h2', {}, room.name),
          h('span', { class: 'code', id: 'room-code' }, room.code),
          copy,
        ),
        h('div', { class: 'teams' }, column('red'), column('blue')),
        h('h3', {}, 'Pick your position'),
        roles,
        mine && h('div', { class: 'hint' }, `${ROLE_NAME[mine.role]}: ${ROLE_HINT[mine.role]}`),
        settingsForm(room.settings, isHost, act.settings),
        publicBox(),
        isHost
          ? button('Start Game', act.start, 'primary')
          : h('p', { class: 'hint' }, 'Waiting for the host to start…'),
        button('Leave', act.leave),
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
                button('Join', () => act.join(r.code)),
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
