import { DOWN, KICK, LEFT, RIGHT, UP, USE } from '@crateball/sim';

const KEYS: Record<string, number> = {
  ArrowUp: UP,
  KeyW: UP,
  ArrowDown: DOWN,
  KeyS: DOWN,
  ArrowLeft: LEFT,
  KeyA: LEFT,
  ArrowRight: RIGHT,
  KeyD: RIGHT,
  Space: KICK,
  KeyX: KICK,
  KeyE: USE,
  KeyF: USE,
  ShiftLeft: USE,
  ShiftRight: USE,
};

export interface Keyboard {
  bits(): number;
  release(): void;
}

/** Keyboard → input byte. Keys only count while the game (not a text field) has focus. */
export function createKeyboard(target: Window, onKey?: (code: string) => void): Keyboard {
  // Physical keys held: W and ArrowUp both mean UP, and letting go of one must not drop the other.
  const held = new Set<string>();
  // Typing in a field, or Space/arrows on a focused button or dropdown: that is the page's, not the game's.
  const typing = (e: KeyboardEvent) =>
    e.target instanceof HTMLInputElement ||
    e.target instanceof HTMLTextAreaElement ||
    e.target instanceof HTMLSelectElement ||
    e.target instanceof HTMLButtonElement;
  target.addEventListener('keydown', (e) => {
    if (typing(e)) return;
    if (KEYS[e.code]) {
      held.add(e.code);
      e.preventDefault();
    } else if (!e.repeat) onKey?.(e.code);
  });
  target.addEventListener('keyup', (e) => held.delete(e.code));
  target.addEventListener('blur', () => held.clear());
  return {
    bits: () => {
      let b = 0;
      for (const code of held) b |= KEYS[code] ?? 0;
      return b;
    },
    release: () => held.clear(),
  };
}
