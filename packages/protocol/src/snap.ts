/**
 * Binary snapshots. A snapshot used to be the whole game state as JSON (~3.7 KB, 30 a second per player);
 * now it is a binary frame, and usually only what changed since the snapshot before.
 *
 * The codec knows nothing about the game's shape: it walks plain data (objects, arrays, numbers, strings,
 * booleans, null), so a new field in the sim needs no change here. What a client gets is exactly what
 * `JSON.parse(encodeGame(g))` gives: numbers that are not whole are rounded to 1/STATE_SCALE (positions to
 * a thousandth of a pixel), non-finite numbers become null, undefined fields are left out, and the loot
 * randomness is not sent. Prediction therefore starts from bit-identical states as before.
 *
 * Frame: kind (1 = key, the whole state; 2 = delta against the snapshot at `base`), tick, ack, q, lead,
 * [base], held inputs, then the state (key) or the patch (delta). A delta is only sent to a client the
 * server knows has `base` (the connection is ordered and reliable; a snapshot skipped for a slow client
 * makes its next one a key frame).
 */
import type { Game } from '@crateball/sim';

/** Numbers travel at 1/STATE_SCALE, the precision the sim keeps its state at (the sim's STATE_SCALE; a
 * test keeps the two equal: protocol takes only types from the sim). */
export const STATE_SCALE = 100_000;

/** JSON-shaped data: what a snapshot state is made of. */
export type Plain = null | boolean | number | string | Plain[] | { [k: string]: Plain };
type PlainObj = { [k: string]: Plain };

export const SNAP_KEY = 1;
export const SNAP_DELTA = 2;

// Value tags.
const T_NULL = 0;
const T_FALSE = 1;
const T_TRUE = 2;
const T_INT = 3;
const T_FIXED = 4;
const T_F64 = 5;
const T_STR = 6;
const T_ARR = 7;
const T_OBJ = 8;
// Patch tags (a plain value tag in a patch means "replace with this value").
const P_OBJ = 9;
const P_ARR = 10;
const P_NUM = 11;
// Object patch entries.
const E_END = 0;
const E_SET = 1;
const E_DEL = 2;

/** Whole numbers in this range travel as integers; beyond it as doubles. */
const INT_MAX = Number.MAX_SAFE_INTEGER;
/** Numbers whose thousandths fit a safe integer comfortably: these can travel as a difference. */
const DELTA_MAX = 1e9;

const isObj = (v: unknown): v is PlainObj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One number as a client sees it (as `encodeGame` rounded it). */
function num(v: number): number | null {
  if (!Number.isFinite(v)) return null;
  if (v === 0) return 0; // -0 too, as JSON wrote it
  return Number.isInteger(v) ? v : Math.round(v * STATE_SCALE) / STATE_SCALE;
}

function plain(v: unknown): Plain | undefined {
  if (v === null) return null;
  switch (typeof v) {
    case 'number':
      return num(v);
    case 'string':
    case 'boolean':
      return v;
    case 'object': {
      if (Array.isArray(v)) return v.map((x) => plain(x) ?? null);
      const out: PlainObj = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const p = plain(x);
        if (p !== undefined) out[k] = p;
      }
      return out;
    }
    default:
      return undefined; // undefined, functions: left out, like JSON
  }
}

/** The state a client gets for this game: a plain copy, rounded like the JSON snapshots were. */
export function snapState(g: Game): Plain {
  return plain({ ...g, lootRng: null }) as Plain;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** A growing byte buffer. */
export class Writer {
  buf = new Uint8Array(1024);
  len = 0;
  private view = new DataView(this.buf.buffer);

  private room(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(b: number) {
    this.room(1);
    this.buf[this.len++] = b;
  }
  /** Unsigned integer up to 2^53, 7 bits a byte. */
  uint(n: number) {
    this.room(8);
    while (n >= 0x80) {
      this.buf[this.len++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
    }
    this.buf[this.len++] = n;
  }
  /** Signed integer (zigzag), |n| up to 2^52. */
  int(n: number) {
    this.uint(n >= 0 ? n * 2 : -n * 2 - 1);
  }
  f64(n: number) {
    this.room(8);
    this.view.setFloat64(this.len, n);
    this.len += 8;
  }
  str(s: string) {
    // ASCII (ids, keys, names mostly) without the encoder; anything else through it.
    let ascii = true;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) ascii = false;
    if (ascii) {
      this.uint(s.length);
      this.room(s.length);
      for (let i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i);
      return;
    }
    const b = utf8.encode(s);
    this.uint(b.length);
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class Reader {
  pos = 0;
  private view: DataView;
  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  u8(): number {
    if (this.pos >= this.buf.length) throw new Error('snapshot: out of data');
    return this.buf[this.pos++]!;
  }
  uint(): number {
    let n = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      n += (b & 0x7f) * mul;
      if (b < 0x80) return n;
      mul *= 0x80;
    }
    throw new Error('snapshot: bad integer');
  }
  int(): number {
    const z = this.uint();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }
  f64(): number {
    if (this.pos + 8 > this.buf.length) throw new Error('snapshot: out of data');
    const n = this.view.getFloat64(this.pos);
    this.pos += 8;
    return n;
  }
  str(): string {
    const n = this.uint();
    if (this.pos + n > this.buf.length) throw new Error('snapshot: out of data');
    const s = fromUtf8.decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
}

function writeNumber(w: Writer, v: number) {
  if (Number.isInteger(v) && Math.abs(v) <= INT_MAX / 2) {
    w.u8(T_INT);
    w.int(v);
  } else if (Math.abs(v) < DELTA_MAX) {
    w.u8(T_FIXED);
    w.int(Math.round(v * STATE_SCALE));
  } else {
    w.u8(T_F64);
    w.f64(v);
  }
}

export function writeValue(w: Writer, v: Plain) {
  if (v === null) return w.u8(T_NULL);
  switch (typeof v) {
    case 'boolean':
      return w.u8(v ? T_TRUE : T_FALSE);
    case 'number':
      return writeNumber(w, v);
    case 'string':
      w.u8(T_STR);
      return w.str(v);
  }
  if (Array.isArray(v)) {
    w.u8(T_ARR);
    w.uint(v.length);
    for (const x of v) writeValue(w, x);
    return;
  }
  const keys = Object.keys(v);
  w.u8(T_OBJ);
  w.uint(keys.length);
  for (const k of keys) {
    w.str(k);
    writeValue(w, v[k]!);
  }
}

const MAX_DEPTH = 32;
/** Arrays and objects in a snapshot stay far below this; anything bigger is a broken frame. */
const MAX_LEN = 100_000;

function readValueTagged(r: Reader, tag: number, depth: number): Plain {
  if (depth > MAX_DEPTH) throw new Error('snapshot: too deep');
  switch (tag) {
    case T_NULL:
      return null;
    case T_FALSE:
      return false;
    case T_TRUE:
      return true;
    case T_INT:
      return r.int();
    case T_FIXED:
      return r.int() / STATE_SCALE;
    case T_F64:
      return r.f64();
    case T_STR:
      return r.str();
    case T_ARR: {
      const n = r.uint();
      if (n > MAX_LEN) throw new Error('snapshot: array too long');
      const a: Plain[] = [];
      for (let i = 0; i < n; i++) a.push(readValueTagged(r, r.u8(), depth + 1));
      return a;
    }
    case T_OBJ: {
      const n = r.uint();
      if (n > MAX_LEN) throw new Error('snapshot: object too big');
      const o: PlainObj = {};
      for (let i = 0; i < n; i++) {
        const k = r.str();
        // Own data properties only: a "__proto__" key must not reach the prototype.
        Object.defineProperty(o, k, {
          value: readValueTagged(r, r.u8(), depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return o;
    }
  }
  throw new Error(`snapshot: bad tag ${tag}`);
}

export function readValue(r: Reader): Plain {
  return readValueTagged(r, r.u8(), 0);
}

/**
 * Whether patching `prev` gives `cur`'s key order too: the decoder keeps the remaining keys where they
 * were and appends new ones. If not (keys reordered), the object is sent whole, so a client's state keeps
 * exactly the key order JSON.parse used to give it.
 */
function keepsOrder(prev: PlainObj, cur: PlainObj): boolean {
  const ck = Object.keys(cur);
  let i = 0;
  for (const k of Object.keys(prev)) if (Object.hasOwn(cur, k) && ck[i++] !== k) return false;
  for (; i < ck.length; i++) if (Object.hasOwn(prev, ck[i]!)) return false;
  return true;
}

/** Writes what turns `prev` into `cur`; false (and nothing written) if they are equal. */
export function writePatch(w: Writer, prev: Plain, cur: Plain): boolean {
  if (prev === cur) return false;
  if (typeof prev === 'number' && typeof cur === 'number') {
    if (Math.abs(prev) < DELTA_MAX && Math.abs(cur) < DELTA_MAX) {
      // Both as a client holds them (rounded to 1/STATE_SCALE): the difference in those units is exact.
      w.u8(P_NUM);
      w.int(Math.round(cur * STATE_SCALE) - Math.round(prev * STATE_SCALE));
      return true;
    }
  } else if (Array.isArray(prev) && Array.isArray(cur)) {
    const mark = w.len;
    w.u8(P_ARR);
    w.uint(cur.length);
    let changed = prev.length !== cur.length;
    for (let i = 0; i < cur.length; i++) {
      const at = w.len;
      w.uint(i + 1);
      if (i < prev.length ? writePatch(w, prev[i]!, cur[i]!) : (writeValue(w, cur[i]!), true)) changed = true;
      else w.len = at;
    }
    w.uint(0);
    if (!changed) w.len = mark;
    return changed;
  } else if (isObj(prev) && isObj(cur) && keepsOrder(prev, cur)) {
    const mark = w.len;
    w.u8(P_OBJ);
    let changed = false;
    for (const k of Object.keys(cur)) {
      const at = w.len;
      w.u8(E_SET);
      w.str(k);
      const had = Object.hasOwn(prev, k);
      if (had ? writePatch(w, prev[k]!, cur[k]!) : (writeValue(w, cur[k]!), true)) changed = true;
      else w.len = at;
    }
    for (const k of Object.keys(prev))
      if (!Object.hasOwn(cur, k)) {
        w.u8(E_DEL);
        w.str(k);
        changed = true;
      }
    w.u8(E_END);
    if (!changed) w.len = mark;
    return changed;
  }
  writeValue(w, cur);
  return true;
}

/** Applies a patch to `prev` (objects and arrays are changed in place) and returns the new value. */
export function readPatch(r: Reader, prev: Plain, depth = 0): Plain {
  if (depth > MAX_DEPTH) throw new Error('snapshot: too deep');
  const tag = r.u8();
  switch (tag) {
    case P_NUM: {
      if (typeof prev !== 'number') throw new Error('snapshot: number patch on a non-number');
      return (Math.round(prev * STATE_SCALE) + r.int()) / STATE_SCALE;
    }
    case P_ARR: {
      if (!Array.isArray(prev)) throw new Error('snapshot: array patch on a non-array');
      const n = r.uint();
      if (n > MAX_LEN) throw new Error('snapshot: array too long');
      const old = prev.length;
      prev.length = n;
      for (let i = old; i < n; i++) prev[i] = null; // filled by the entries below
      for (let i = r.uint(); i !== 0; i = r.uint()) {
        const at = i - 1;
        if (at >= n) throw new Error('snapshot: index out of range');
        prev[at] = at < old ? readPatch(r, prev[at]!, depth + 1) : readValue(r);
      }
      return prev;
    }
    case P_OBJ: {
      if (!isObj(prev)) throw new Error('snapshot: object patch on a non-object');
      for (let e = r.u8(); e !== E_END; e = r.u8()) {
        const k = r.str();
        if (e === E_DEL) delete prev[k];
        else if (e === E_SET) {
          const v = Object.hasOwn(prev, k) ? readPatch(r, prev[k]!, depth + 1) : readValue(r);
          Object.defineProperty(prev, k, { value: v, enumerable: true, writable: true, configurable: true });
        } else throw new Error('snapshot: bad entry');
      }
      return prev;
    }
  }
  return readValueTagged(r, tag, depth);
}

export interface SnapHeader {
  tick: number;
  ack: number;
  q: number;
  lead: number;
  /** Held inputs per player id (see the `snap` message). */
  h: Record<string, number>;
}

/** The parts of a frame every client in the room shares: the body once, the header per client. */
export function encodeFrame(kind: number, head: SnapHeader, base: number, body: Uint8Array): Uint8Array {
  const w = new Writer();
  w.u8(kind);
  w.uint(head.tick);
  w.uint(head.ack);
  w.uint(head.q);
  w.uint(head.lead);
  if (kind === SNAP_DELTA) w.uint(base);
  const ids = Object.keys(head.h);
  w.uint(ids.length);
  for (const id of ids) {
    w.str(id);
    w.uint(head.h[id]!);
  }
  const out = new Uint8Array(w.len + body.length);
  out.set(w.buf.subarray(0, w.len));
  out.set(body, w.len);
  return out;
}

/** The body of a key frame: the whole state. */
export function keyBody(state: Plain): Uint8Array {
  const w = new Writer();
  writeValue(w, state);
  return w.bytes();
}

/** The body of a delta frame (an empty patch if nothing changed). */
export function deltaBody(prev: Plain, cur: Plain): Uint8Array {
  const w = new Writer();
  if (!writePatch(w, prev, cur)) {
    // Nothing changed (the same tick twice): an object patch with no entries.
    w.u8(P_OBJ);
    w.u8(E_END);
  }
  return w.bytes();
}

/** What a client keeps between frames: the last state it decoded and its tick. */
export interface SnapDecoder {
  state: Plain | null;
  tick: number;
}

export const createSnapDecoder = (): SnapDecoder => ({ state: null, tick: -1 });

export interface DecodedSnap extends SnapHeader {
  /** The full state after this frame (the decoder's own copy: do not change it). */
  state: Plain;
}

/**
 * Decodes a frame against what the decoder holds. Null if it cannot be applied: a delta against a state
 * this client does not have (nothing is changed then; the next key frame repairs it). Throws on a broken
 * frame.
 */
export function decodeFrame(bytes: Uint8Array, dec: SnapDecoder): DecodedSnap | null {
  const r = new Reader(bytes);
  const kind = r.u8();
  if (kind !== SNAP_KEY && kind !== SNAP_DELTA) throw new Error('snapshot: bad kind');
  const tick = r.uint();
  const ack = r.uint();
  const q = r.uint();
  const lead = r.uint();
  const base = kind === SNAP_DELTA ? r.uint() : -1;
  const n = r.uint();
  if (n > 64) throw new Error('snapshot: too many held inputs');
  const h: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const id = r.str();
    Object.defineProperty(h, id, { value: r.uint(), enumerable: true, writable: true, configurable: true });
  }
  let state: Plain;
  if (kind === SNAP_KEY) state = readValue(r);
  else {
    if (dec.state === null || dec.tick !== base) return null;
    state = readPatch(r, dec.state);
  }
  if (!r.done) throw new Error('snapshot: trailing data');
  dec.state = state;
  dec.tick = tick;
  return { tick, ack, q, lead, h, state };
}
