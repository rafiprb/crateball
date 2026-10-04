import type { ServerMessage } from '@crateball/protocol';

type Line = Extract<ServerMessage, { t: 'chat' }>;

/** In a match a message stays this long, then fades; new ones stack on top of the old. */
const SHOW_MS = 6000;
const FADE_MS = 600;
const KEEP = 30;

export interface Chat {
  add(line: Line, mine?: boolean): void;
  /** Lobby: the log and the input are always shown. Game: recent lines float, Enter opens the input. */
  mode(m: 'lobby' | 'game' | 'off'): void;
  /** Lobby: sit inside the lobby panel (its slot is rebuilt on every update); null = float over the game. */
  mount(slot: HTMLElement | null): void;
  /** Enter in a match: focus the input. */
  open(): void;
  readonly typing: boolean;
}

export function createChat(send: (text: string) => void, onOpen: () => void): Chat {
  const root = document.createElement('div');
  root.id = 'chat';
  const log = document.createElement('ul');
  const input = document.createElement('input');
  input.maxLength = 120;
  input.placeholder = 'Say something… (Enter)';
  input.autocomplete = 'off';
  root.append(log, input);
  document.body.append(root);
  let current: 'lobby' | 'game' | 'off' = 'off';

  const refresh = () => {
    root.dataset.mode = current;
    root.hidden = current === 'off';
    input.hidden = current === 'game' && document.activeElement !== input;
    if (current === 'lobby') log.scrollTop = log.scrollHeight;
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const text = input.value.trim();
      if (text) send(text);
      input.value = '';
      if (current === 'game') input.blur();
    } else if (e.key === 'Escape') {
      input.value = '';
      input.blur();
    }
  });
  input.addEventListener('blur', refresh);

  return {
    add(line, mine = false) {
      const li = document.createElement('li');
      li.className = line.team;
      const who = document.createElement('b');
      if (mine) who.className = 'me';
      who.textContent = `${line.name}${line.team === 'spec' ? ' (watching)' : ''}: `;
      li.append(who, line.text);
      li.dataset.at = String(performance.now());
      log.append(li);
      while (log.children.length > KEEP) log.firstElementChild?.remove();
      // In a match: visible for a few seconds, then fades out (still in the log for the lobby).
      setTimeout(() => li.classList.add('old'), SHOW_MS);
      setTimeout(() => li.classList.add('gone'), SHOW_MS + FADE_MS);
      refresh();
    },
    mode(m) {
      if (m === current) return;
      // Typing in the lobby when the match starts: give the keys back to the game.
      if (m !== 'lobby') input.blur();
      if (m === 'off') log.replaceChildren();
      current = m;
      refresh();
    },
    mount(slot) {
      const parent = slot ?? document.body;
      if (root.parentElement === parent) return;
      // Moving a focused input drops its focus: keep typing where you were.
      const focused = document.activeElement === input;
      const caret = input.selectionStart;
      parent.append(root);
      if (focused) {
        input.focus();
        if (caret !== null) input.setSelectionRange(caret, caret);
      }
      log.scrollTop = log.scrollHeight;
    },
    open() {
      if (current === 'off') return;
      onOpen();
      input.hidden = false;
      input.focus();
    },
    get typing() {
      return document.activeElement === input;
    },
  };
}
